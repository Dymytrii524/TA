// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase} from "./TestBase.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {TransAtlasEscrow as E} from "../src/TransAtlasEscrow.sol";

contract F07RegressionTest is TestBase {
    MockUSDC t; E e; bytes32 ID;
    address constant P=address(101); address constant C=address(102);
    address constant G=address(103); address constant A=address(104);
    address constant B=address(105); address constant X=address(106);
    bytes32 constant NONCE=keccak256("TA-F07"); bytes32 constant COM=keccak256("evidence");
    uint256 constant AMOUNT=1000e6;
    function setUp() public {
        vm.chainId(31337);vm.warp(100000);
        t=new MockUSDC();e=new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
        ID=e.deriveEscrowId(P,NONCE);t.mint(P,AMOUNT);vm.prank(P);t.approve(address(e),AMOUNT);
    }
    function fund() internal {
        vm.prank(P);e.create(NONCE,C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM,2);
    }
    function active() internal {fund();bytes32 terms=e.getDeal(ID).termsHash;vm.prank(C);e.accept(ID,terms);}
    function delivered() internal {active();vm.prank(C);e.submitDelivery(ID,COM);}
    function testF07LegacyCreateSelectorRejected() public {
        vm.prank(P);
        (bool success,)=address(e).call(abi.encodeWithSignature(
            "create(bytes32,address,uint256,uint64,uint64,bytes32)",
            NONCE,C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM));
        ok(!success);eq(e.locked(),0);
    }
    function testF07WrongTermsVersionRejected() public {
        vm.expectRevert(E.Invalid.selector);vm.prank(P);
        e.create(NONCE,C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM,1);
    }
    function atDeadline() internal {
        active();vm.warp(e.getDeal(ID).deliveryBy);
        vm.prank(C);e.submitDelivery(ID,COM);
    }
    function testF07DeadlineDeliveryGetsFull48Hours() public {
        atDeadline();E.Deal memory d=e.getDeal(ID);
        eq(d.deliverySubmittedAt,d.deliveryBy);eq(d.reviewBy,d.deliveryBy+48 hours);
        vm.warp(d.deliveryBy+1);vm.prank(P);e.approveDelivery(ID,COM);
        eq(e.getDeal(ID).releaseAt,block.timestamp+e.challengePeriod());
    }
    function testF07EarlyDeliveryStartsClockImmediately() public {
        delivered();eq(e.getDeal(ID).reviewBy,block.timestamp+48 hours);
        ok(e.getDeal(ID).reviewBy<e.getDeal(ID).deliveryBy);
    }
    function testF07ApprovalAtReviewBoundary() public {
        atDeadline();vm.warp(e.getDeal(ID).reviewBy);
        vm.expectRevert(E.Deadline.selector);e.escalateOverdue(ID);
        vm.prank(P);e.approveDelivery(ID,COM);
        eq(uint256(e.getDeal(ID).state),uint256(E.State.Accepted));
    }
    function testF07ApprovalBeforeReviewBoundary() public {
        atDeadline();vm.warp(e.getDeal(ID).reviewBy-1);
        vm.prank(P);e.approveDelivery(ID,COM);
    }
    function testF07ApprovalAfterReviewBoundaryRejected() public {
        atDeadline();vm.warp(e.getDeal(ID).reviewBy+1);
        vm.expectRevert(E.Deadline.selector);vm.prank(P);e.approveDelivery(ID,COM);
        e.escalateOverdue(ID);eq(e.totalClaimable(),0);
        eq(uint256(e.getDeal(ID).state),uint256(E.State.Disputed));
    }
    function testF07DeliveredCannotEscalateOnOldDeadline() public {
        atDeadline();vm.warp(e.getDeal(ID).deliveryBy+1);
        vm.expectRevert(E.Deadline.selector);vm.prank(X);e.escalateOverdue(ID);
        vm.warp(e.getDeal(ID).reviewBy-1);
        vm.expectRevert(E.Deadline.selector);e.escalateOverdue(ID);
    }
    function testF07LateSubmissionRejected() public {
        active();vm.warp(e.getDeal(ID).deliveryBy+1);
        vm.expectRevert(E.Deadline.selector);vm.prank(C);e.submitDelivery(ID,COM);
        e.escalateOverdue(ID);eq(e.totalClaimable(),0);
    }
    function testF07DeliveryJustBeforeDeadline() public {
        active();vm.warp(e.getDeal(ID).deliveryBy-1);
        vm.prank(C);e.submitDelivery(ID,COM);
        eq(e.getDeal(ID).reviewBy,block.timestamp+48 hours);
    }
    function testF07NoClockResetOnRepeatDelivery() public {
        delivered();uint64 r=e.getDeal(ID).reviewBy;vm.warp(block.timestamp+1);
        vm.expectRevert(E.WrongState.selector);vm.prank(C);e.submitDelivery(ID,COM);
        eq(e.getDeal(ID).reviewBy,r);
    }
    function testF07DirectDisputeAfterReviewExpiry() public {
        atDeadline();vm.warp(e.getDeal(ID).reviewBy+1);
        vm.prank(C);e.dispute(ID,COM);eq(e.totalClaimable(),0);
    }
    function testF07SilenceNeverCreatesClaims() public {
        atDeadline();vm.warp(e.getDeal(ID).reviewBy+100 days);
        vm.expectRevert(E.WrongState.selector);e.finalize(ID);
        eq(e.totalClaimable(),0);eq(e.locked(),AMOUNT);
    }
    function testF07DisputeWinsAgainstLaterApproval() public {
        atDeadline();vm.prank(C);e.dispute(ID,COM);
        vm.expectRevert(E.WrongState.selector);vm.prank(P);e.approveDelivery(ID,COM);
    }
    function testF07Uint64OverflowRejected() public {
        vm.expectRevert(E.Invalid.selector);vm.prank(P);
        e.create(NONCE,C,AMOUNT,uint64(block.timestamp+1 days),type(uint64).max,COM,2);
    }
    function testF07TermsV2IncludesReviewPeriod() public {
        fund();E.Deal memory d=e.getDeal(ID);
        bytes32 expected=keccak256(bytes.concat(abi.encode(e.TERMS_DOMAIN(),uint256(31337),
            address(e),ID,P,C,address(t),AMOUNT),abi.encode(d.acceptBy,d.deliveryBy,COM,A,B,
            e.challengePeriod(),e.arbitrationPeriod(),uint64(48 hours))));
        ok(expected==d.termsHash);
        bytes32 old=keccak256(abi.encode(uint256(31337),address(e),ID,P,C,address(t),
            AMOUNT,d.acceptBy,d.deliveryBy,COM,A,B,e.challengePeriod(),e.arbitrationPeriod()));
        vm.expectRevert(E.Invalid.selector);vm.prank(C);e.accept(ID,old);
    }
}
