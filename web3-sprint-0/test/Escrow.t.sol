// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TransAtlasEscrow as E} from "../src/TransAtlasEscrow.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {TestBase} from "./TestBase.sol";

contract EscrowTest is TestBase {
    MockUSDC t;
    E e;
    address constant P = address(101);
    address constant C = address(102);
    address constant G = address(103);
    address constant A = address(104);
    address constant B = address(105);
    address constant X = address(106);
    bytes32 constant NONCE = keccak256("TA-1");
    bytes32 ID;
    bytes32 constant COM = keccak256("private-document-with-random-salt");
    uint256 constant AMOUNT = 1000e6;
    function setUp() public {
        vm.chainId(31337);
        vm.warp(100000);
        t = new MockUSDC();
        e = new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
        ID = e.deriveEscrowId(P,NONCE);
        t.mint(P,1000000e6);
        vm.prank(P); t.approve(address(e),type(uint256).max);
    }
    function fund() internal {
        vm.prank(P); e.create(NONCE,C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
    }
    function active() internal {
        fund(); bytes32 terms = e.getDeal(ID).termsHash;
        vm.prank(C); e.accept(ID,terms);
    }
    function delivered() internal { active(); vm.prank(C); e.submitDelivery(ID,COM); }
    function accepted() internal { delivered(); vm.prank(P); e.approveDelivery(ID,COM); }
    function disputed() internal { active(); vm.prank(P); e.dispute(ID,COM); }
    function testHappyPath() public {
        accepted(); vm.warp(e.getDeal(ID).releaseAt); e.finalize(ID);
        eq(e.claimable(C),AMOUNT); eq(t.balanceOf(C),0);
        vm.prank(C); e.withdraw();
        eq(t.balanceOf(C),AMOUNT); eq(e.locked(),0); eq(e.totalClaimable(),0);
    }
    function testOnlyPayerApproves() public {
        delivered(); vm.expectRevert(E.Forbidden.selector); vm.prank(X); e.approveDelivery(ID,COM);
    }
    function testOnlyCarrierAccepts() public {
        fund(); bytes32 terms = e.getDeal(ID).termsHash;
        vm.expectRevert(E.Forbidden.selector); vm.prank(X); e.accept(ID,terms);
    }
    function testOnlyCarrierSubmits() public {
        active(); vm.expectRevert(E.Forbidden.selector); vm.prank(P); e.submitDelivery(ID,COM);
    }
    function testWrongTerms() public {
        fund(); vm.expectRevert(E.Invalid.selector); vm.prank(C); e.accept(ID,bytes32(uint256(1)));
    }
    function testWrongEvidence() public {
        delivered(); vm.expectRevert(E.Invalid.selector); vm.prank(P); e.approveDelivery(ID,bytes32(uint256(1)));
    }
    function testNoGpsAutoRelease() public {
        delivered(); vm.expectRevert(E.WrongState.selector); e.finalize(ID);
    }
    function testNoPrematureRelease() public {
        accepted(); vm.expectRevert(E.Deadline.selector); e.finalize(ID);
    }
    function testDisputeBlocksRelease() public {
        accepted(); vm.prank(C); e.dispute(ID,COM);
        vm.warp(block.timestamp+2 days);
        vm.expectRevert(E.WrongState.selector); e.finalize(ID);
    }
    function testBoundaryDisputeClosed() public {
        accepted(); vm.warp(e.getDeal(ID).releaseAt);
        vm.expectRevert(E.Deadline.selector); vm.prank(P); e.dispute(ID,COM);
        e.finalize(ID);
    }
    function testSplitResolution() public {
        disputed(); vm.prank(A); e.resolve(ID,400e6);
        eq(e.claimable(P),400e6); eq(e.claimable(C),600e6);
    }
    function testUnauthorizedResolver() public {
        disputed(); vm.expectRevert(E.Forbidden.selector); vm.prank(P); e.resolve(ID,AMOUNT);
    }
    function testBackupCannotResolveEarly() public {
        disputed(); vm.expectRevert(E.Forbidden.selector); vm.prank(B); e.resolve(ID,AMOUNT);
    }
    function testBackupAtBoundary() public {
        disputed(); vm.warp(block.timestamp+7 days);
        vm.expectRevert(E.Forbidden.selector); vm.prank(A); e.resolve(ID,0);
        vm.prank(B); e.resolve(ID,AMOUNT);
        eq(e.claimable(P),AMOUNT);
    }
    function testOverAllocationRejected() public {
        disputed(); vm.expectRevert(E.Invalid.selector); vm.prank(A); e.resolve(ID,AMOUNT+1);
    }
    function testDoubleSettlementRejected() public {
        accepted(); vm.warp(e.getDeal(ID).releaseAt); e.finalize(ID);
        vm.expectRevert(E.WrongState.selector); e.finalize(ID);
    }
    function testDoubleWithdrawRejected() public {
        accepted(); vm.warp(e.getDeal(ID).releaseAt); e.finalize(ID);
        vm.prank(C); e.withdraw();
        vm.expectRevert(E.Invalid.selector); vm.prank(C); e.withdraw();
    }
    function testIdReplayRejected() public {
        fund(); vm.expectRevert(E.Invalid.selector); fund();
    }
    function testChainChangeRejected() public {
        fund(); vm.chainId(1);
        vm.expectRevert(E.UnsupportedChain.selector); vm.prank(C); e.cancelUnaccepted(ID);
    }
    function testMainnetDeploymentBlocked() public {
        vm.chainId(137); vm.expectRevert(E.UnsupportedChain.selector);
        new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
    }
    function testAmoyWrongTokenBlocked() public {
        vm.chainId(80002); vm.expectRevert(E.Invalid.selector);
        new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
    }
    function testZeroAndTooLargeAmounts() public {
        vm.expectRevert(E.Invalid.selector); vm.prank(P);
        e.create(NONCE,C,0,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
        vm.expectRevert(E.Invalid.selector); vm.prank(P);
        e.create(NONCE,C,10001e6,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
    }
    function testFeeTokenRejectedAtomically() public {
        t.setFee(true); vm.expectRevert(E.Invalid.selector); fund();
        eq(e.totalDeposited(),0); eq(t.balanceOf(address(e)),0);
    }
    function testTokenPauseDepositRollback() public {
        t.setPaused(true); vm.expectRevert(); fund(); eq(e.locked(),0);
    }
    function testBlockedWithdrawalRetainsClaim() public {
        accepted(); vm.warp(e.getDeal(ID).releaseAt); e.finalize(ID);
        t.setBlocked(C,true); vm.expectRevert(); vm.prank(C); e.withdraw();
        eq(e.claimable(C),AMOUNT); eq(e.totalWithdrawn(),0);
        t.setBlocked(C,false); vm.prank(C); e.withdraw(); eq(e.claimable(C),0);
    }
    function testIntakePausePreservesExit() public {
        fund(); vm.prank(G); e.setIntakePaused(true);
        vm.expectRevert(E.Paused.selector); fund();
        vm.prank(C); e.cancelUnaccepted(ID);
        vm.prank(P); e.withdraw(); eq(e.totalWithdrawn(),AMOUNT);
    }
    function testUnauthorizedPause() public {
        vm.expectRevert(E.Forbidden.selector); vm.prank(X); e.setIntakePaused(true);
    }
    function testPayerCannotCancelEarly() public {
        fund(); vm.expectRevert(E.Forbidden.selector); vm.prank(P); e.cancelUnaccepted(ID);
    }
    function testPayerRefundAfterAcceptanceDeadline() public {
        fund(); vm.warp(e.getDeal(ID).acceptBy+1);
        vm.prank(P); e.cancelUnaccepted(ID); eq(e.claimable(P),AMOUNT);
    }
    function testCarrierAcceptsExactDeadline() public {
        fund(); E.Deal memory d=e.getDeal(ID); vm.warp(d.acceptBy);
        vm.prank(C); e.accept(ID,d.termsHash); eq(uint256(e.getDeal(ID).state),2);
    }
    function testLateAcceptanceBlocked() public {
        fund(); E.Deal memory d=e.getDeal(ID); vm.warp(d.acceptBy+1);
        vm.expectRevert(E.Deadline.selector); vm.prank(C); e.accept(ID,d.termsHash);
    }
    function testOverdueEscalationNoSilentPayout() public {
        delivered(); vm.warp(e.getDeal(ID).deliveryBy+1); e.escalateOverdue(ID);
        eq(uint256(e.getDeal(ID).state),5); eq(e.totalClaimable(),0);
    }
    function testDonationDoesNotCreateLiability() public {
        fund(); t.mint(address(e),123); eq(e.locked(),AMOUNT); eq(e.totalDeposited(),AMOUNT);
    }
    function testTransferCallbackCannotReenter() public {
        t.setCallback(address(e),abi.encodeCall(e.withdraw,()));
        fund(); ok(!t.callbackSucceeded()); eq(e.locked(),AMOUNT);
        ok(t.callbackError()==bytes4(keccak256("ReentrancyGuardReentrantCall()")));
    }
    function testFuzzConservation(uint96 raw,uint96 split) public {
        uint256 amount=uint256(raw)%10000e6+1;
        uint256 refund=uint256(split)%(amount+1);
        vm.prank(P); e.create(NONCE,C,amount,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
        bytes32 terms=e.getDeal(ID).termsHash;
        vm.prank(C); e.accept(ID,terms); vm.prank(P); e.dispute(ID,COM);
        vm.prank(A); e.resolve(ID,refund);
        eq(e.claimable(P)+e.claimable(C),amount);
        if(refund>0){ vm.prank(P); e.withdraw(); }
        if(amount>refund){ vm.prank(C); e.withdraw(); }
        eq(e.totalDeposited(),e.totalWithdrawn()+e.locked()+e.totalClaimable());
        eq(t.balanceOf(address(e)),0);
    }
}
