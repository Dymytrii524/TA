// F07-A pure policy used by the server adapter and cross-layer tests.
// Inputs are VERIFIED on-chain state/actor, never an arbitrary HTTP body.
import {iface} from './wallet.mjs';
import {REVIEW_PERIOD} from '../tools/escrow-identity.mjs';
const bad=message=>{throw new Error(message)};
export function reviewClock(deal){
  const submitted=BigInt(deal.deliverySubmittedAt),review=BigInt(deal.reviewBy);
  if(submitted===0n){
    if(review!==0n||[3,4].includes(Number(deal.state)))bad('missing review clock');
    return {terms_version:2,review_period_seconds:REVIEW_PERIOD,delivery_submitted_at:null,review_by:null};
  }
  if(submitted>BigInt(deal.deliveryBy)||review!==submitted+BigInt(REVIEW_PERIOD))bad('invalid review clock');
  return {terms_version:2,review_period_seconds:REVIEW_PERIOD,
    delivery_submitted_at:new Date(Number(submitted)*1000).toISOString(),review_by:new Date(Number(review)*1000).toISOString()};
}
export function reviewAction({deal,id,actor,action,evidence,now}){
  reviewClock(deal);const state=Number(deal.state),t=BigInt(now);
  if(action==='approveDelivery'){
    if(actor.toLowerCase()!==deal.payer.toLowerCase())bad('forbidden');
    if(state!==3)bad('wrong state');
    if(t>BigInt(deal.reviewBy))bad('review expired');
    if(evidence!==deal.evidence)bad('wrong evidence');
    return iface.encodeFunctionData(action,[id,evidence]);
  }
  if(action==='escalateOverdue'){
    if(![2,3].includes(state))bad('wrong state');
    if(t<=BigInt(state===3?deal.reviewBy:deal.deliveryBy))bad('not overdue');
    return iface.encodeFunctionData(action,[id]);
  }
  bad('unsupported review action');
}
