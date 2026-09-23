// Shared deterministic encoding, no RPC, signing, broadcast or wallet keys.
import {AbiCoder,keccak256,toUtf8Bytes} from 'ethers';
const abi=AbiCoder.defaultAbiCoder();
export const ID_DOMAIN=keccak256(toUtf8Bytes('TRANS_ATLAS_ESCROW_ID_V1'));
export function deriveEscrowId(chainId,contract,payer,nonce){
  if(BigInt(nonce)===0n) throw new Error('zero escrow nonce');
  return keccak256(abi.encode(['bytes32','uint256','address','address','bytes32'],
    [ID_DOMAIN,chainId,contract,payer,nonce]));
}
export function deriveTermsHash(t){
  return keccak256(abi.encode(
    ['uint256','address','bytes32','address','address','address','uint256',
      'uint64','uint64','bytes32','address','address','uint64','uint64'],
    [t.chainId,t.contract,t.id,t.payer,t.carrier,t.token,t.amount,
      t.acceptBy,t.deliveryBy,t.agreement,t.arbiter,t.backup,t.challenge,t.arbitration]));
}
