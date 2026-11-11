//! Quiet Treasury - Mandate registry (on-chain source of truth).
//!
//! Access model:
//!   * `dao`   (a Sputnik DAO account): create_mandate, cancel_mandate, set_agent. Because a Sputnik
//!             FunctionCall proposal executes as the DAO account, "DAO-only" == "a DAO vote approved it".
//!   * `agent` (the OutLayer agent wallet account): mark_funded, record_chunk, begin_settlement,
//!             complete, expire. The agent can never create or widen a mandate.
//! State machine mirrors src/engine/schema.ts TRANSITIONS.
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao: AccountId,
    agent: AccountId,
    next_id: u64,
    mandates: IterableMap<u64, Mandate>,
    /// treasurer -> number of mandates settled with zero violations (drives approval tiers)
    trust: IterableMap<AccountId, u32>,
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
        Self { dao, agent, next_id: 0, mandates: IterableMap::new(b"m"), trust: IterableMap::new(b"t") }
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
        require!(terms_hash.len() == 64, "terms_hash must be 64 hex chars");
        require!(end_ns > start_ns, "end must be after start");
        require!(end_ns > env::block_timestamp(), "already expired");
        require!(max_sell.0 > 0, "max_sell must be > 0");
        require!(matches!(tier.as_str(), "small" | "mid" | "large"), "bad tier");
        let id = self.next_id;
        self.next_id += 1;
        let m = Mandate {
            id,
            treasurer,
            terms_hash,
            terms_json,
            sell_token,
            max_sell,
            start_ns,
            end_ns,
            tier,
            status: Status::Approved,
            sold: U128(0),
            chunks: 0,
            created_ns: env::block_timestamp(),
            report_hash: None,
            revealed_terms: None,
        };
        self.mandates.insert(id, m);
        id
    }

    pub fn cancel_mandate(&mut self, id: u64) {
        self.assert_dao();
        self.transition(id, Status::Cancelled);
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_dao();
        self.agent = agent;
    }

    // ---------- agent-only ----------
    pub fn mark_funded(&mut self, id: u64) {
        self.assert_agent();
        self.transition(id, Status::Funded);
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
    }

    pub fn begin_settlement(&mut self, id: u64) {
        self.assert_agent();
        self.transition(id, Status::Settling);
    }

    /// `violations` must be 0 for the treasurer to earn trust.
    pub fn complete(&mut self, id: u64, report_hash: String, violations: u32, revealed_terms: Option<String>) {
        self.assert_agent();
        require!(report_hash.len() == 64, "report_hash must be 64 hex chars");
        self.transition(id, Status::Completed);
        let treasurer = {
            let m = self.mandates.get_mut(&id).expect("no such mandate");
            m.report_hash = Some(report_hash);
            m.revealed_terms = revealed_terms;
            m.treasurer.clone()
        };
        if violations == 0 {
            let cur = self.trust.get(&treasurer).copied().unwrap_or(0);
            self.trust.insert(treasurer, cur + 1);
        }
    }

    pub fn expire(&mut self, id: u64) {
        self.assert_agent();
        let end = self.mandates.get(&id).expect("no such mandate").end_ns;
        require!(env::block_timestamp() > end, "not expired yet");
        self.transition(id, Status::Expired);
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
    pub fn get_config(&self) -> (AccountId, AccountId, u64) {
        (self.dao.clone(), self.agent.clone(), self.next_id)
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
}
