//! Quiet Treasury - Mandate registry v2 (on-chain source of truth).
//!
//! Access model:
//!   * `dao`   (a Sputnik DAO account): create_mandate, cancel_mandate, set_agent, set_paused, propose_dao. Because a Sputnik
//!             FunctionCall proposal executes as the DAO account, "DAO-only" == "a DAO vote approved it".
//!   * `agent` (the OutLayer agent wallet account): mark_funded, record_chunk, begin_settlement,
//!             complete, expire. The agent can never create or widen a mandate (the worker's key is also a NEAR
//!             function-call key limited to exactly these five methods).
//! State machine mirrors src/engine/schema.ts TRANSITIONS.
//!
//! v2 adds: NEP-297 events for every state change (sealed terms are never logged), a state `version` with a feature-gated `migrate`,
//! a DAO-controlled pause (stops new mandates only, never settlement), a two-step DAO handover, typed views and NEP-330 source metadata.
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

pub const STATE_VERSION: u32 = 2;

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Approved,
    Funded,
    Executing,
    Settling,
    Completed,
    Cancelled,
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub id: u64,
    pub treasurer: AccountId,
    /// sha256 hex of the canonical terms JSON (always set; commit-reveal for sealed mandates)
    pub terms_hash: String,
    /// full terms JSON, None when the mandate is sealed
    pub terms_json: Option<String>,
    pub sell_token: String,
    pub max_sell: U128,
    pub start_ns: u64,
    pub end_ns: u64,
    pub tier: String,
    pub status: Status,
    pub sold: U128,
    pub chunks: u32,
    pub created_ns: u64,
    pub report_hash: Option<String>,
    /// revealed terms for sealed mandates (set at completion)
    pub revealed_terms: Option<String>,
}

/// NEP-297 events (standard "quiet_treasury", version 1.0.0). Anyone can rebuild a mandate's history from these logs.
/// Sealed mandates log only the commitment: never terms, recipients or the floor.
#[near(event_json(standard = "quiet_treasury"))]
pub enum Event {
    #[event_version("1.0.0")]
    MandateCreated { id: u64, treasurer: AccountId, terms_hash: String, sell_token: String, max_sell: U128, start_ns: u64, end_ns: u64, tier: String, sealed: bool },
    #[event_version("1.0.0")]
    MandateFunded { id: u64 },
    #[event_version("1.0.0")]
    ChunkRecorded { id: u64, index: u32, sold_amount: U128, total_sold: U128 },
    #[event_version("1.0.0")]
    SettlementBegun { id: u64 },
    #[event_version("1.0.0")]
    MandateCompleted { id: u64, report_hash: String, violations: u32, trust_after: u32, revealed: bool },
    #[event_version("1.0.0")]
    MandateCancelled { id: u64, sold: U128 },
    #[event_version("1.0.0")]
    MandateExpired { id: u64 },
    #[event_version("1.0.0")]
    AgentChanged { agent: AccountId },
    #[event_version("1.0.0")]
    PausedChanged { paused: bool },
    #[event_version("1.0.0")]
    DaoProposed { pending_dao: AccountId },
    #[event_version("1.0.0")]
    DaoChanged { dao: AccountId },
}

#[derive(Serialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Stats {
    pub version: u32,
    pub paused: bool,
    pub dao: AccountId,
    pub agent: AccountId,
    pub pending_dao: Option<AccountId>,
    pub mandates: u64,
    pub approved: u64,
    pub funded: u64,
    pub executing: u64,
    pub settling: u64,
    pub completed: u64,
    pub cancelled: u64,
    pub expired: u64,
    pub chunks_recorded: u64,
    pub treasurers_with_trust: u64,
}

#[near(
    contract_state,
    contract_metadata(
        version = "2.0.0",
        link = "https://github.com/tannmayygupta/near/tree/main/contracts/mandate",
        standard(standard = "nep330", version = "1.2.0")
    )
)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao: AccountId,
    agent: AccountId,
    next_id: u64,
    mandates: IterableMap<u64, Mandate>,
    /// treasurer -> number of mandates settled with zero violations (drives approval tiers)
    trust: IterableMap<AccountId, u32>,
    /// state layout version (2). `migrate` upgrades v1 state.
    version: u32,
    /// DAO-controlled: when true no NEW mandate can be created. Funding, trading, settlement and cancel keep working so nothing gets stuck.
    paused: bool,
    /// two-step DAO handover: set by `propose_dao`, takes effect only when that account calls `accept_dao`
    pending_dao: Option<AccountId>,
}

fn allowed(from: &Status, to: &Status) -> bool {
    use Status::*;
    matches!(
        (from, to),
        (Approved, Funded)
            | (Approved, Cancelled)
            | (Approved, Expired)
            | (Funded, Executing)
            | (Funded, Settling)
            | (Funded, Cancelled)
            | (Funded, Expired)
            | (Executing, Settling)
            | (Executing, Cancelled)
            | (Executing, Expired)
            | (Settling, Completed)
    )
}

#[near]
impl Contract {
    #[init]
    pub fn new(dao: AccountId, agent: AccountId) -> Self {
        require!(dao != agent, "the DAO and the agent must be different accounts");
        Self { dao, agent, next_id: 0, mandates: IterableMap::new(b"m"), trust: IterableMap::new(b"t"), version: STATE_VERSION, paused: false, pending_dao: None }
    }

    // ---------- DAO-only ----------
    pub fn create_mandate(
        &mut self,
        treasurer: AccountId,
        terms_hash: String,
        terms_json: Option<String>,
        sell_token: String,
        max_sell: U128,
        start_ns: u64,
        end_ns: u64,
        tier: String,
    ) -> u64 {
        self.assert_dao();
        require!(!self.paused, "the contract is paused: no new mandates");
        require!(terms_hash.len() == 64, "terms_hash must be 64 hex chars");
        require!(end_ns > start_ns, "end must be after start");
        require!(end_ns > env::block_timestamp(), "already expired");
        require!(max_sell.0 > 0, "max_sell must be > 0");
        require!(matches!(tier.as_str(), "small" | "mid" | "large"), "bad tier");
        let id = self.next_id;
        self.next_id += 1;
        let sealed = terms_json.is_none();
        let m = Mandate {
            id,
            treasurer: treasurer.clone(),
            terms_hash: terms_hash.clone(),
            terms_json,
            sell_token: sell_token.clone(),
            max_sell,
            start_ns,
            end_ns,
            tier: tier.clone(),
            status: Status::Approved,
            sold: U128(0),
            chunks: 0,
            created_ns: env::block_timestamp(),
            report_hash: None,
            revealed_terms: None,
        };
        self.mandates.insert(id, m);
        Event::MandateCreated { id, treasurer, terms_hash, sell_token, max_sell, start_ns, end_ns, tier, sealed }.emit();
        id
    }

    pub fn cancel_mandate(&mut self, id: u64) {
        self.assert_dao();
        self.transition(id, Status::Cancelled);
        let sold = self.mandates.get(&id).expect("no such mandate").sold;
        Event::MandateCancelled { id, sold }.emit();
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_dao();
        require!(agent != self.dao, "the agent must not be the DAO");
        self.agent = agent.clone();
        Event::AgentChanged { agent }.emit();
    }

    /// Stops NEW mandates only. Existing mandates can still be funded, traded, settled and cancelled.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_dao();
        self.paused = paused;
        Event::PausedChanged { paused }.emit();
    }

    /// Step 1 of a DAO handover. Nothing changes until the proposed account calls `accept_dao`.
    pub fn propose_dao(&mut self, new_dao: AccountId) {
        self.assert_dao();
        require!(new_dao != self.agent, "the new DAO must not be the agent");
        self.pending_dao = Some(new_dao.clone());
        Event::DaoProposed { pending_dao: new_dao }.emit();
    }

    /// Step 2: only the proposed account can accept.
    pub fn accept_dao(&mut self) {
        let pending = self.pending_dao.clone().expect("no DAO handover is pending");
        require!(env::predecessor_account_id() == pending, "only the proposed DAO may accept");
        self.dao = pending.clone();
        self.pending_dao = None;
        Event::DaoChanged { dao: pending }.emit();
    }

    // ---------- agent-only ----------
    pub fn mark_funded(&mut self, id: u64) {
        self.assert_agent();
        self.transition(id, Status::Funded);
        Event::MandateFunded { id }.emit();
    }

    /// Idempotent: replaying an already-recorded index is a no-op; skipping ahead panics.
    pub fn record_chunk(&mut self, id: u64, index: u32, sold_amount: U128) {
        self.assert_agent();
        let now = env::block_timestamp();
        let m = self.mandates.get_mut(&id).expect("no such mandate");
        require!(matches!(m.status, Status::Funded | Status::Executing), "mandate not executable");
        require!(now >= m.start_ns && now <= m.end_ns, "outside mandate window");
        if index < m.chunks {
            return; // already recorded
        }
        require!(index == m.chunks, "chunk index out of order");
        let new_sold = m.sold.0.checked_add(sold_amount.0).expect("overflow");
        require!(new_sold <= m.max_sell.0, "exceeds mandate budget");
        m.sold = U128(new_sold);
        m.chunks += 1;
        m.status = Status::Executing;
        Event::ChunkRecorded { id, index, sold_amount, total_sold: U128(new_sold) }.emit();
    }

    pub fn begin_settlement(&mut self, id: u64) {
        self.assert_agent();
        self.transition(id, Status::Settling);
        Event::SettlementBegun { id }.emit();
    }

    /// `violations` must be 0 for the treasurer to earn trust.
    pub fn complete(&mut self, id: u64, report_hash: String, violations: u32, revealed_terms: Option<String>) {
        self.assert_agent();
        require!(report_hash.len() == 64, "report_hash must be 64 hex chars");
        self.transition(id, Status::Completed);
        let revealed = revealed_terms.is_some();
        let treasurer = {
            let m = self.mandates.get_mut(&id).expect("no such mandate");
            m.report_hash = Some(report_hash.clone());
            m.revealed_terms = revealed_terms;
            m.treasurer.clone()
        };
        let mut trust_after = self.trust.get(&treasurer).copied().unwrap_or(0);
        if violations == 0 {
            trust_after += 1;
            self.trust.insert(treasurer, trust_after);
        }
        Event::MandateCompleted { id, report_hash, violations, trust_after, revealed }.emit();
    }

    pub fn expire(&mut self, id: u64) {
        self.assert_agent();
        let end = self.mandates.get(&id).expect("no such mandate").end_ns;
        require!(env::block_timestamp() > end, "not expired yet");
        self.transition(id, Status::Expired);
        Event::MandateExpired { id }.emit();
    }

    // ---------- views ----------
    pub fn get_mandate(&self, id: u64) -> Option<Mandate> {
        self.mandates.get(&id).cloned()
    }
    pub fn list_mandates(&self, from: u64, limit: u64) -> Vec<Mandate> {
        self.mandates.iter().skip(from as usize).take(limit as usize).map(|(_, m)| m.clone()).collect()
    }
    pub fn get_trust(&self, treasurer: AccountId) -> u32 {
        self.trust.get(&treasurer).copied().unwrap_or(0)
    }
    /// (dao, agent, next_id): kept as a tuple for the existing clients; `get_stats` is the typed view.
    pub fn get_config(&self) -> (AccountId, AccountId, u64) {
        (self.dao.clone(), self.agent.clone(), self.next_id)
    }
    pub fn get_version(&self) -> u32 {
        self.version
    }
    pub fn is_paused(&self) -> bool {
        self.paused
    }
    pub fn get_stats(&self) -> Stats {
        let mut s = Stats {
            version: self.version, paused: self.paused, dao: self.dao.clone(), agent: self.agent.clone(), pending_dao: self.pending_dao.clone(),
            mandates: self.next_id, approved: 0, funded: 0, executing: 0, settling: 0, completed: 0, cancelled: 0, expired: 0, chunks_recorded: 0,
            treasurers_with_trust: self.trust.len() as u64,
        };
        for (_, m) in self.mandates.iter() {
            s.chunks_recorded += m.chunks as u64;
            match m.status {
                Status::Approved => s.approved += 1,
                Status::Funded => s.funded += 1,
                Status::Executing => s.executing += 1,
                Status::Settling => s.settling += 1,
                Status::Completed => s.completed += 1,
                Status::Cancelled => s.cancelled += 1,
                Status::Expired => s.expired += 1,
            }
        }
        s
    }

    // ---------- internals ----------
    fn assert_dao(&self) {
        require!(env::predecessor_account_id() == self.dao, "only the DAO may call this");
    }
    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "only the agent may call this");
    }
    fn transition(&mut self, id: u64, to: Status) {
        let m = self.mandates.get_mut(&id).expect("no such mandate");
        require!(allowed(&m.status, &to), "illegal state transition");
        m.status = to;
    }
}

/// v1 -> v2 state upgrade (build with `--features migrate`, deploy, call `migrate`, then redeploy the normal build).
#[cfg(feature = "migrate")]
mod migration {
    use super::*;

    #[near(serializers = [borsh])]
    pub struct ContractV1 {
        pub dao: AccountId,
        pub agent: AccountId,
        pub next_id: u64,
        pub mandates: IterableMap<u64, Mandate>,
        pub trust: IterableMap<AccountId, u32>,
    }

    #[near]
    impl Contract {
        #[private]
        #[init(ignore_state)]
        pub fn migrate() -> Self {
            let old: ContractV1 = env::state_read().expect("no v1 state to migrate");
            Self { dao: old.dao, agent: old.agent, next_id: old.next_id, mandates: old.mandates, trust: old.trust, version: STATE_VERSION, paused: false, pending_dao: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(pred: &str, ts_ns: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(pred)).block_timestamp(ts_ns).build());
    }
    const T0: u64 = 1_000_000_000_000;
    fn fresh() -> Contract {
        ctx("dao.test", T0);
        let mut c = Contract::new(acc("dao.test"), acc("agent.test"));
        c.create_mandate(acc("alice.test"), HASH.into(), Some("{}".into()), "nep141:wrap.near".into(), U128(1000), T0, T0 + 10_000, "small".into());
        c
    }

    #[test] fn dao_creates_and_starts_approved() {
        let c = fresh();
        let m = c.get_mandate(0).unwrap();
        assert_eq!(m.status, Status::Approved);
        assert_eq!(c.get_config().2, 1);
    }
    #[test] #[should_panic(expected = "only the DAO")] fn non_dao_cannot_create() {
        let mut c = fresh();
        ctx("mallory.test", T0);
        c.create_mandate(acc("alice.test"), HASH.into(), None, "x".into(), U128(1), T0, T0 + 5, "small".into());
    }
    #[test] #[should_panic(expected = "only the agent")] fn non_agent_cannot_record() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        ctx("mallory.test", T0 + 2); c.record_chunk(0, 0, U128(10));
    }
    #[test] fn happy_path_and_trust() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        c.record_chunk(0, 0, U128(400));
        c.record_chunk(0, 1, U128(500));
        assert_eq!(c.get_mandate(0).unwrap().sold.0, 900);
        c.begin_settlement(0);
        c.complete(0, HASH.into(), 0, None);
        assert_eq!(c.get_mandate(0).unwrap().status, Status::Completed);
        assert_eq!(c.get_trust(acc("alice.test")), 1);
    }
    #[test] fn violations_do_not_earn_trust() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0); c.begin_settlement(0);
        c.complete(0, HASH.into(), 2, None);
        assert_eq!(c.get_trust(acc("alice.test")), 0);
    }
    #[test] fn record_chunk_is_idempotent() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        c.record_chunk(0, 0, U128(100));
        c.record_chunk(0, 0, U128(100)); // replay
        let m = c.get_mandate(0).unwrap();
        assert_eq!((m.chunks, m.sold.0), (1, 100));
    }
    #[test] #[should_panic(expected = "exceeds mandate budget")] fn cannot_exceed_budget() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        c.record_chunk(0, 0, U128(600));
        c.record_chunk(0, 1, U128(600));
    }
    #[test] #[should_panic(expected = "out of order")] fn cannot_skip_chunk_index() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        c.record_chunk(0, 3, U128(1));
    }
    #[test] #[should_panic(expected = "outside mandate window")] fn cannot_trade_after_expiry_window() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0);
        ctx("agent.test", T0 + 20_000);
        c.record_chunk(0, 0, U128(1));
    }
    #[test] #[should_panic(expected = "mandate not executable")] fn cannot_trade_before_funding() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1);
        c.record_chunk(0, 0, U128(1));
    }
    #[test] fn dao_can_cancel_and_agent_then_blocked() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0); c.record_chunk(0, 0, U128(10));
        ctx("dao.test", T0 + 2); c.cancel_mandate(0);
        assert_eq!(c.get_mandate(0).unwrap().status, Status::Cancelled);
    }
    #[test] #[should_panic(expected = "mandate not executable")] fn no_trading_after_cancel() {
        let mut c = fresh();
        ctx("dao.test", T0 + 1); c.cancel_mandate(0);
        ctx("agent.test", T0 + 2); c.record_chunk(0, 0, U128(1));
    }
    #[test] #[should_panic(expected = "illegal state transition")] fn cannot_complete_from_executing() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.mark_funded(0); c.record_chunk(0, 0, U128(1));
        c.complete(0, HASH.into(), 0, None);
    }
    #[test] #[should_panic(expected = "not expired yet")] fn cannot_expire_early() {
        let mut c = fresh();
        ctx("agent.test", T0 + 1); c.expire(0);
    }
    #[test] fn expire_after_deadline() {
        let mut c = fresh();
        ctx("agent.test", T0 + 20_000); c.expire(0);
        assert_eq!(c.get_mandate(0).unwrap().status, Status::Expired);
    }
    #[test] fn dao_can_rotate_agent() {
        let mut c = fresh();
        ctx("dao.test", T0); c.set_agent(acc("agent2.test"));
        ctx("agent2.test", T0 + 1); c.mark_funded(0);
    }

    // ---------- property tests: random sequences must never break the invariants ----------
    use proptest::prelude::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    proptest! {
        // P1: whatever the agent tries (any amounts, replays, skips), sold never exceeds the budget, chunks counts only accepted records,
        // and sold is exactly the sum of the accepted amounts.
        #[test]
        fn prop_budget_and_chunk_accounting(ops in proptest::collection::vec((0u32..6, 0u128..700), 1..40)) {
            let mut c = fresh();
            ctx("agent.test", T0 + 1); c.mark_funded(0);
            let mut accepted_sum: u128 = 0; let mut accepted: u32 = 0;
            for (idx_jitter, amt) in ops {
                let cur = c.get_mandate(0).unwrap().chunks;
                let idx = cur.saturating_sub(1).saturating_add(idx_jitter); // below, at and above the next index: replays, valid, skips
                let before = c.get_mandate(0).unwrap();
                let r = catch_unwind(AssertUnwindSafe(|| c.record_chunk(0, idx, U128(amt))));
                let after = c.get_mandate(0).unwrap();
                if r.is_ok() && idx == before.chunks { accepted_sum += amt; accepted += 1; }
                if r.is_err() { prop_assert_eq!((before.sold.0, before.chunks), (after.sold.0, after.chunks)); } // a rejected call changes nothing
            }
            let m = c.get_mandate(0).unwrap();
            prop_assert!(m.sold.0 <= m.max_sell.0);
            prop_assert_eq!(m.sold.0, accepted_sum);
            prop_assert_eq!(m.chunks, accepted);
        }

        // P2: replaying an already-recorded chunk any number of times is a no-op.
        #[test]
        fn prop_replay_is_idempotent(amt in 1u128..1000, replays in 1usize..12) {
            let mut c = fresh();
            ctx("agent.test", T0 + 1); c.mark_funded(0);
            c.record_chunk(0, 0, U128(amt));
            let snap = c.get_mandate(0).unwrap();
            for _ in 0..replays { c.record_chunk(0, 0, U128(amt)); }
            let m = c.get_mandate(0).unwrap();
            prop_assert_eq!((m.sold.0, m.chunks), (snap.sold.0, snap.chunks));
        }

        // P3: outside [start, end] no chunk is ever accepted.
        #[test]
        fn prop_no_chunk_outside_window(ts in prop_oneof![0u64..T0, (T0 + 10_001)..(T0 * 3)], amt in 1u128..500) {
            let mut c = fresh();
            ctx("agent.test", T0 + 1); c.mark_funded(0);
            ctx("agent.test", ts);
            let r = catch_unwind(AssertUnwindSafe(|| c.record_chunk(0, 0, U128(amt))));
            prop_assert!(r.is_err());
            prop_assert_eq!(c.get_mandate(0).unwrap().chunks, 0);
        }

        // P4: nobody but the agent can move a mandate forward; nobody but the DAO can create or cancel.
        #[test]
        fn prop_only_the_right_accounts_act(name in "[a-z]{3,12}") {
            prop_assume!(name != "agent" && name != "dao");
            let who = format!("{}.test", name);
            let mut c = fresh();
            ctx("agent.test", T0 + 1); c.mark_funded(0);
            ctx(&who, T0 + 2);
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.record_chunk(0, 0, U128(1)))).is_err());
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.begin_settlement(0))).is_err());
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.cancel_mandate(0))).is_err());
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.set_agent(acc("evil.test")))).is_err());
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.set_paused(true))).is_err());
            prop_assert!(catch_unwind(AssertUnwindSafe(|| c.propose_dao(acc("evil.test")))).is_err());
            let created = catch_unwind(AssertUnwindSafe(|| { c.create_mandate(acc("alice.test"), HASH.into(), None, "x".into(), U128(1), T0, T0 + 5, "small".into()); }));
            prop_assert!(created.is_err());
            prop_assert_eq!(c.get_mandate(0).unwrap().chunks, 0);
        }

        // P5: trust equals the number of mandates completed with zero violations (never decreases, +1 per clean completion only).
        #[test]
        fn prop_trust_counts_clean_completions(violations in proptest::collection::vec(0u32..3, 1..12)) {
            ctx("dao.test", T0);
            let mut c = Contract::new(acc("dao.test"), acc("agent.test"));
            // the mocked storage of a test thread outlives one proptest case, so count relative to the starting trust
            let base = c.get_trust(acc("alice.test")); let mut clean = 0u32; let mut last = base;
            for (i, v) in violations.iter().enumerate() {
                ctx("dao.test", T0);
                c.create_mandate(acc("alice.test"), HASH.into(), None, "nep141:wrap.near".into(), U128(10), T0, T0 + 10_000, "small".into());
                ctx("agent.test", T0 + 1);
                c.mark_funded(i as u64); c.begin_settlement(i as u64); c.complete(i as u64, HASH.into(), *v, None);
                if *v == 0 { clean += 1; }
                let t = c.get_trust(acc("alice.test"));
                prop_assert!(t >= last);
                last = t;
            }
            prop_assert_eq!(c.get_trust(acc("alice.test")), base + clean);
        }
    }

    // ---------- v2: events, pause, two-step DAO handover, typed views, version ----------
    use near_sdk::test_utils::get_logs;
    fn events() -> Vec<String> { get_logs().into_iter().filter(|l| l.starts_with("EVENT_JSON:")).collect() }

    #[test] fn every_state_change_emits_a_nep297_event_and_sealed_terms_never_appear() {
        ctx("dao.test", T0);
        let mut c = Contract::new(acc("dao.test"), acc("agent.test"));
        c.create_mandate(acc("alice.test"), HASH.into(), None, "nep141:wrap.near".into(), U128(1000), T0, T0 + 10_000, "small".into()); // sealed: terms_json = None
        let mut all = events();
        ctx("agent.test", T0 + 1);
        c.mark_funded(0); c.record_chunk(0, 0, U128(400)); c.begin_settlement(0);
        c.complete(0, HASH.into(), 0, Some("{\"salt\":\"s3cret\",\"terms\":{\"minPrice\":\"2.5\"}}".into()));
        all.extend(events());
        let ev = all.join("\n");
        for name in ["mandate_created", "mandate_funded", "chunk_recorded", "settlement_begun", "mandate_completed"] { assert!(ev.contains(name), "missing event {name}"); }
        assert!(ev.contains("\"standard\":\"quiet_treasury\"") && ev.contains("\"version\":\"1.0.0\""));
        assert!(ev.contains("\"sealed\":true"));
        assert!(ev.contains("\"trust_after\":1") && ev.contains("\"total_sold\":\"400\""));
        assert!(!ev.contains("minPrice") && !ev.contains("s3cret"), "revealed terms must never be written to the logs");
    }
    #[test] fn cancel_and_expire_emit_events() {
        let mut c = fresh(); ctx("dao.test", T0 + 1); c.cancel_mandate(0);
        assert!(events().join("").contains("mandate_cancelled"));
        let mut d = fresh(); ctx("agent.test", T0 + 20_000); d.expire(0);
        assert!(events().join("").contains("mandate_expired"));
    }
    #[test] fn replayed_chunk_emits_no_second_event() {
        let mut c = fresh(); ctx("agent.test", T0 + 1); c.mark_funded(0); c.record_chunk(0, 0, U128(100));
        let n = events().iter().filter(|e| e.contains("chunk_recorded")).count();
        c.record_chunk(0, 0, U128(100));
        assert_eq!(events().iter().filter(|e| e.contains("chunk_recorded")).count(), n);
    }
    #[test] fn version_is_2_and_views_are_typed() {
        let c = fresh(); assert_eq!(c.get_version(), 2); assert!(!c.is_paused());
        let s = c.get_stats(); assert_eq!((s.version, s.mandates, s.approved, s.completed), (2, 1, 1, 0)); assert_eq!(s.dao, acc("dao.test"));
    }
    #[test] fn stats_count_every_status() {
        let mut c = fresh();
        ctx("dao.test", T0); c.create_mandate(acc("bob.test"), HASH.into(), Some("{}".into()), "x".into(), U128(10), T0, T0 + 10_000, "small".into());
        ctx("agent.test", T0 + 1); c.mark_funded(0); c.record_chunk(0, 0, U128(5));
        ctx("dao.test", T0 + 2); c.cancel_mandate(1);
        let s = c.get_stats(); assert_eq!((s.executing, s.cancelled, s.approved, s.chunks_recorded), (1, 1, 0, 1));
    }
    #[test] #[should_panic(expected = "only the DAO")] fn only_the_dao_can_pause() { let mut c = fresh(); ctx("agent.test", T0); c.set_paused(true); }
    #[test] #[should_panic(expected = "paused")] fn pause_blocks_new_mandates() {
        let mut c = fresh(); ctx("dao.test", T0); c.set_paused(true);
        c.create_mandate(acc("alice.test"), HASH.into(), None, "x".into(), U128(1), T0, T0 + 5, "small".into());
    }
    #[test] fn pause_never_traps_a_running_mandate() {
        let mut c = fresh(); ctx("agent.test", T0 + 1); c.mark_funded(0); c.record_chunk(0, 0, U128(10));
        ctx("dao.test", T0 + 2); c.set_paused(true); assert!(c.is_paused());
        ctx("agent.test", T0 + 3); c.record_chunk(0, 1, U128(10)); c.begin_settlement(0); c.complete(0, HASH.into(), 0, None);
        assert_eq!(c.get_mandate(0).unwrap().status, Status::Completed);
        ctx("dao.test", T0 + 4); c.set_paused(false); c.create_mandate(acc("alice.test"), HASH.into(), None, "x".into(), U128(1), T0, T0 + 10_000, "small".into());
    }
    #[test] fn dao_handover_is_two_step() {
        let mut c = fresh(); ctx("dao.test", T0); c.propose_dao(acc("dao2.test"));
        assert_eq!(c.get_stats().pending_dao, Some(acc("dao2.test"))); assert_eq!(c.get_stats().dao, acc("dao.test")); // nothing changed yet
        ctx("dao2.test", T0 + 1); c.accept_dao();
        let s = c.get_stats(); assert_eq!((s.dao, s.pending_dao), (acc("dao2.test"), None));
    }
    #[test] #[should_panic(expected = "only the proposed DAO")] fn only_the_proposed_account_can_accept() { let mut c = fresh(); ctx("dao.test", T0); c.propose_dao(acc("dao2.test")); ctx("mallory.test", T0 + 1); c.accept_dao(); }
    #[test] #[should_panic(expected = "no DAO handover is pending")] fn accept_without_a_proposal_panics() { let mut c = fresh(); ctx("dao2.test", T0); c.accept_dao(); }
    #[test] #[should_panic(expected = "only the DAO")] fn old_dao_loses_power_after_handover() {
        let mut c = fresh(); ctx("dao.test", T0); c.propose_dao(acc("dao2.test")); ctx("dao2.test", T0 + 1); c.accept_dao();
        ctx("dao.test", T0 + 2); c.cancel_mandate(0);
    }
    #[test] #[should_panic(expected = "must be different")] fn dao_and_agent_must_differ() { ctx("dao.test", T0); let _ = Contract::new(acc("same.test"), acc("same.test")); }
    #[test] #[should_panic(expected = "must not be the DAO")] fn agent_cannot_be_set_to_the_dao() { let mut c = fresh(); ctx("dao.test", T0); c.set_agent(acc("dao.test")); }
    #[test] #[should_panic(expected = "must not be the agent")] fn dao_cannot_be_proposed_as_the_agent() { let mut c = fresh(); ctx("dao.test", T0); c.propose_dao(acc("agent.test")); }

    #[cfg(feature = "migrate")]
    #[test] fn migrate_upgrades_v1_state_and_keeps_every_mandate() {
        use super::migration::ContractV1;
        ctx("dao.test", T0);
        let mut old = ContractV1 { dao: acc("dao.test"), agent: acc("agent.test"), next_id: 1, mandates: IterableMap::new(b"m"), trust: IterableMap::new(b"t") };
        old.mandates.insert(0, Mandate { id: 0, treasurer: acc("alice.test"), terms_hash: HASH.into(), terms_json: Some("{}".into()), sell_token: "x".into(), max_sell: U128(7), start_ns: T0, end_ns: T0 + 10, tier: "small".into(), status: Status::Funded, sold: U128(3), chunks: 1, created_ns: T0, report_hash: None, revealed_terms: None });
        old.trust.insert(acc("alice.test"), 4);
        old.mandates.flush(); old.trust.flush(); // store collections cache writes: flush them like a real v1 contract would before it returned
        env::state_write(&old);
        testing_env!(VMContextBuilder::new().current_account_id(acc("qt.test")).predecessor_account_id(acc("qt.test")).block_timestamp(T0).build());
        let c = Contract::migrate();
        assert_eq!(c.get_version(), 2); assert!(!c.is_paused());
        assert_eq!(c.get_mandate(0).unwrap().sold.0, 3); assert_eq!(c.get_trust(acc("alice.test")), 4); assert_eq!(c.get_config().2, 1);
    }
}