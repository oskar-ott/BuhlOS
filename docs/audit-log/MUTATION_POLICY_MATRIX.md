# Mutation Policy Matrix

## Status

PLANNED / NOT IMPLEMENTED

This matrix proposes the target policy for future implementation. It is not enforcement status.

## Status values

- `REQUIRED_BLOCKING`: mutation must fail or be retried atomically if the audit write cannot be guaranteed.
- `REQUIRED_BEST_EFFORT`: mutation may proceed if audit write fails, but the failure must be observable and retryable where possible.
- `OPTIONAL`: audit may be useful but is not required for the product guarantee.
- `NOT_REQUIRED`: no audit expected.
- `NEEDS_DECISION`: policy needs product/ops confirmation before implementation.

## Matrix

| Domain | Mutation | Required audit? | Blocking? | Reason | Notes |
| ------ | -------- | --------------- | --------- | ------ | ----- |
| Time entries | Worker submit | NEEDS_DECISION | NEEDS_DECISION | Field capture should not be casually blocked, but submitted hours are payroll-adjacent | Consider best-effort for worker submit, blocking for office on-behalf submit |
| Time entries | Admin/LH edit submitted/rejected entry | REQUIRED_BLOCKING | Yes | Payroll-adjacent state changes require traceability | Worker edits before approval may be a separate policy |
| Time entries | Approve | REQUIRED_BLOCKING | Yes | Approval authorizes payable hours | Include actor, target user, date, totals, job allocations |
| Time entries | Reject | REQUIRED_BLOCKING | Yes | Rejection and reason must be durable | Include reason, previous status, target user, date |
| Time entries | Bulk approve | REQUIRED_BLOCKING | Yes | Bulk payroll decision | Include bulk request id and per-entry audit rows or grouped entry plus details |
| Time entries | Bulk reject | REQUIRED_BLOCKING | Yes | Bulk payroll rejection | Include one shared reason only if that is the UI contract |
| Time entries | Reopen approved/exported entry | REQUIRED_BLOCKING | Yes | Reopens payroll-sensitive state | Include reason and previous export state |
| Time entries | Payroll/export | REQUIRED_BLOCKING | Yes | Payroll output is compliance-critical | Include export id and immutable file/checksum metadata if available |
| Material requests | Create from field | NEEDS_DECISION | NEEDS_DECISION | Field request capture may need to work in poor conditions | Best-effort is acceptable only if failures are observable |
| Material requests | Create from office/admin | REQUIRED_BLOCKING | Yes | Office-created procurement intent should be traceable | If create remains field-capture-like, downgrade only by explicit decision |
| Material requests | Approve | REQUIRED_BLOCKING | Yes | Approves procurement spend/process | Include previous status and approver |
| Material requests | Order | REQUIRED_BLOCKING | Yes | Commits ordering state and supplier/order ref | Include supplier and orderRef, sanitized |
| Material requests | Deliver | REQUIRED_BLOCKING | Yes | Confirms fulfilment | Include delivery note if safe |
| Material requests | Cancel | REQUIRED_BLOCKING | Yes | Cancels procurement path | Include cancel reason |
| Material requests | Urgency/supplier/orderRef edit | REQUIRED_BLOCKING | Yes for supplier/orderRef; NEEDS_DECISION for urgency | Commercial metadata affects procurement decisions | Split if implementation needs finer verbs |
| Evidence | Create/upload routine field evidence | REQUIRED_BEST_EFFORT | No | Blocking onsite capture can lose real field evidence | Audit failure must be logged and surfaced to admin later |
| Evidence | Evidence approval/review | REQUIRED_BLOCKING | Yes | Admin review changes compliance/closeout state | Include before/after status |
| Evidence | Evidence rejection | REQUIRED_BLOCKING | Yes | Rejection reason must be durable | Include sanitized reason |
| Evidence | Evidence unreview/reopen | REQUIRED_BLOCKING | Yes | Reverses an approval | Include reason if provided |
| Evidence | Delete/archive | REQUIRED_BLOCKING | Yes | Destructive evidence action | No route found today; future route must audit |
| Jobs | Create job | REQUIRED_BEST_EFFORT | No by default | Job creation should be traceable but may be recoverable from current state | Upgrade to blocking if job creation grants field access immediately |
| Jobs | Edit job basics | REQUIRED_BEST_EFFORT | No | Operational data changes need trace but low compliance impact | Sensitive/site contact data must be bounded |
| Jobs | Edit structure/modules/client | REQUIRED_BLOCKING | Yes | Changes field workflow, route visibility, or client access | Current legacy job audit is not durable enough |
| Jobs | Publish/unpublish | REQUIRED_BLOCKING | Yes | Controls field visibility | Include previous and next status |
| Jobs | Archive/delete | REQUIRED_BLOCKING | Yes | Removes job from active operations | Prefer archive over hard delete; include reason if UI supports one |
| Jobs | Worker assignment changes | REQUIRED_BLOCKING | Yes | Grants/removes field access and notifications | Implement in users/assignments path |
| Plans | Upload/register plan | NEEDS_DECISION | NEEDS_DECISION | Plan capture can be operationally important, but blocking on audit after file upload risks orphan files | Consider outbox before enforcing blocking |
| Plans | Register rendered pages | OPTIONAL | No | Derived artifact from uploaded plan | Log only if needed for debugging plan viewer state |
| Plans | Edit plan metadata | REQUIRED_BEST_EFFORT | No | Useful history, generally low compliance | Drawing number/revision may be higher risk |
| Plans | Change current/superseded status | REQUIRED_BLOCKING | Yes | Controls which drawings are current | Include supersession links |
| Plans | Archive plan | REQUIRED_BLOCKING | Yes | Removes drawing from normal views | Include previous status |
| Plan markups | Create markup | NEEDS_DECISION | NEEDS_DECISION | Could be a casual annotation or compliance instruction | Product decision needed by markup type/use |
| Plan markups | Update markup content/geometry | REQUIRED_BEST_EFFORT | No | Useful history, but not always compliance-critical | If used for NCR/RFI-like workflows, upgrade |
| Plan markups | Archive markup | REQUIRED_BEST_EFFORT | No by default | Removes overlay from normal view | Upgrade to blocking for compliance markups |
| Plan markups | Toggle `visibleToPhil` | REQUIRED_BLOCKING | Yes | Controls field-visible instruction | Include previous and next visibility |
| Assets/Gear | Create asset | REQUIRED_BEST_EFFORT | No by default | Register creation should be traceable | If created and assigned, transfer portion is blocking |
| Assets/Gear | Transfer holder | REQUIRED_BLOCKING | Yes | Changes custody | Include from/to holder ids and safe names |
| Assets/Gear | Mark damaged | REQUIRED_BLOCKING | Yes | Safety/cost-sensitive asset state | Include note if safe |
| Assets/Gear | Mark missing | REQUIRED_BLOCKING | Yes | Loss/custody-sensitive asset state | Include note if safe |
| Assets/Gear | Mark good | REQUIRED_BLOCKING | Yes | Clears damage/missing state | Include actor and reason/note |
| Assets/Gear | Check/possession report | NEEDS_DECISION | NEEDS_DECISION | Could be routine field confirmation | Best-effort may be enough unless used for compliance |
| Assets/Gear | Edit asset metadata | REQUIRED_BEST_EFFORT | No | Useful register history | Holder edits must stay blocked through transfer route |
| Assets/Gear | Archive/delete asset | REQUIRED_BLOCKING | Yes | Removes asset from active register | Include previous holder and condition |
| Users | Create user/client | REQUIRED_BLOCKING | Yes | Creates account and access | Never log password/PIN/hash |
| Users | Role change | REQUIRED_BLOCKING | Yes | Permission boundary change | No role PUT found today; future route must block |
| Users | Assigned job changes | REQUIRED_BLOCKING | Yes | Grants/removes job access | Include added/removed ids |
| Users | Password/PIN reset/change | REQUIRED_BLOCKING | Yes | Account security event | Log only that secret changed, not the secret or hash |
| Users | Archive/restore/hard delete | REQUIRED_BLOCKING | Yes | Account lifecycle and access control | Include mode and pending-hours guard result if relevant |
| ITPs | Attach ITP | REQUIRED_BEST_EFFORT | No by default | Important setup event, but less critical than signoff | Upgrade to blocking if ITPs become compliance-gated at attach |
| ITPs | Record point | NEEDS_DECISION | NEEDS_DECISION | Field evidence capture vs compliance record tension | Best-effort may preserve onsite capture |
| ITPs | Sign off | REQUIRED_BLOCKING | Yes | Compliance approval | Include override justification if provided |
| ITPs | Reopen | REQUIRED_BLOCKING | Yes | Reverses signoff | Include previous status |
| ITPs | Archive | REQUIRED_BLOCKING | Yes | Removes compliance instance from active queues | Include status at archive |
| Observations | Create | NEEDS_DECISION | NEEDS_DECISION | Field observation capture may need best-effort behavior | If observation is safety/blocker, upgrade |
| Observations | Transition status/priority/assignment | REQUIRED_BEST_EFFORT | No by default | Triage history is useful but not always compliance-critical | Upgrade status changes that assign office action |
| Observations | Convert to snag/material request | REQUIRED_BLOCKING | Yes | Creates real downstream business record | Needs outbox/transaction plan because two stores mutate |
| Read-only APIs | GET/list/filter/search/export preview | NOT_REQUIRED | No | No business state mutation | Exports that stamp records are not read-only |
| Validation failures | Rejected request before mutation | NOT_REQUIRED | No | No business state changed | Security-denial audit can be a separate policy |

## Cautious decisions still needed

- Whether Phil hours submit should be blocking or best-effort.
- Whether material request create from field should block onsite capture.
- Whether observation create should block when audit append fails.
- Whether routine gear check reports are compliance records or operational breadcrumbs.
- Whether plan markup create is a compliance instruction in some jobs.
- Whether job creation should be blocking before field rollout.

