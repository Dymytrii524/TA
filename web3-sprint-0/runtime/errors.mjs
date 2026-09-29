const domainStatuses=new Set([401,403,404,405,409,413,422]);
export class DomainError extends Error{
  constructor(message,status=409){
    super(message);
    if(!domainStatuses.has(status))throw Error('invalid domain error status');
    this.status=status;
  }
}
export class ReconciliationError extends Error{
  constructor(reason){super(reason)}
}
// No arbitrary DB/RPC message, URL, credentials, stack or user input in logs.
const reasons=new Map([
  ['TA_MISMATCH','TA_MISMATCH'],
  ['transaction history conflict','TRANSACTION_CONFLICT'],
  ['event history conflict','EVENT_CONFLICT'],
  ['finality breach: halt reconciliation','FINALITY_BREACH'],
  ['code mismatch','CODE_MISMATCH'],['token mismatch','TOKEN_MISMATCH'],
  ['wrong chain','WRONG_CHAIN'],['failed receipt','RECEIPT_UNAVAILABLE'],
  ['RPC timeout','RPC_TIMEOUT'],['legacy backfill mismatch','BACKFILL_CONFLICT'],
  ['missing verified funding','MISSING_FUNDING'],
]);
const safeCodes=new Set(reasons.values());
export const safeReason=error=>safeCodes.has(error?.message)?error.message:
  reasons.get(error?.message)??'RECONCILIATION_UNAVAILABLE';
