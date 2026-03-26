# Archived: Plan 0004 subplans (completed or superseded)

These subplans are **completed** or **superseded**. They are kept for reference. The active Plan 0004 overview and remaining work live in [../../plan-0004-log-bootstraping/](../../plan-0004-log-bootstraping/).

| Subplan | Reason archived |
|---------|------------------|
| **01** Shared encoding and univocity alignment | ACCEPTED and done. go-univocity, canopy grant codec aligned; inner = ContentHash. |
| **02** REST auth log status | Complete. Implemented in arbor `services/univocity`; endpoints as specified. |
| **03** Grant-sequencing component | Implemented in canopy-api. Async register-grant (303 + status URL), enqueue to same DO, serve-grant, R2 fallback for idtimestamp. |
| **03** Ranger authority leaf append | **SUPERSEDED** by subplan-03-grant-sequencing-component (ranger unchanged except optional idtimestamps in ack). |
| **03** Evaluation async status and unified receipt | Design/evaluation; behaviour implemented in main subplan 03 (unified status URL shape). |
| **04** Signer delegation bootstrap and parent | Design. Implementation done in **Canopy** delegation-signer (subplan-04-delegation-signer-in-canopy). |
| **04** Delegation-signer in Canopy | **Done.** POST /api/delegate/bootstrap, POST /api/delegate/parent; GET /api/public-key/:bootstrap. Bootstrap/parent signing in Canopy (KMS there). |
| **04** Assessment key creation via delegation | Design/assessment for key creation in delegation service. Key creation is now in **Custodian** (arbor), not Canopy delegation-signer; see plan-0011 and devdocs Plan 0013. |
| **05** Queue consumer grant-issuance | **Optional/legacy.** Primary path is canopy (subplan 06); no arbor queue consumer in current design. |
| **08** Grant-first root bootstrap | Implemented. POST /api/grants/bootstrap, register-grant bootstrap branch, register-signed-statement auth; token source should move to Custodian (plan-0011). |

**Active Plan 0004 work** (still in [../../plan-0004-log-bootstraping/](../../plan-0004-log-bootstraping/)): overview, README, **subplan 06** (canopy settlement → grant creation), **subplan 07** (sealer key resolution). See also [../../plan-0011-custodian-integration-and-current-state.md](../../plan-0011-custodian-integration-and-current-state.md) for Custodian integration.
