// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase} from "./TestBase.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {TransAtlasEscrow as E} from "../src/TransAtlasEscrow.sol";

contract P1RegressionTest is TestBase {
    MockUSDC t; E e; bytes32 ID;
    address constant P=address(101); address constant C=address(102);
    address constant G=address(103); address constant A=address(104);
    address constant B=address(105); address constant X=address(106);
    bytes32 constant NONCE=keccak256("TA-1"); bytes32 constant COM=keccak256("agreement");
    uint256 constant AMOUNT=1000e6;
    function setUp() public {
        vm.chainId(31337);vm.warp(100000);
        t=new MockUSDC();e=new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
        ID=e.deriveEscrowId(P,NONCE);
        t.mint(P,10000e6);vm.prank(P);t.approve(address(e),type(uint256).max);
    }
    function fund() internal {
        vm.prank(P);e.create(NONCE,C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
    }
    function testP1AttackerCannotOccupyVictimId() public {
        t.mint(X,1); vm.prank(X); t.approve(address(e),1);
        vm.prank(X);
        bytes32 attackerId=e.create(NONCE,C,1,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
        ok(attackerId!=ID);
        vm.prank(C);e.cancelUnaccepted(attackerId);
        vm.prank(X);e.withdraw();
        eq(t.balanceOf(X),1);
        fund();
        ok(e.getDeal(ID).payer==P);
        eq(e.getDeal(ID).amount,AMOUNT);
    }
    function testP1SettledNonceCannotBeReusedBySamePayer() public {
        fund();vm.prank(C);e.cancelUnaccepted(ID);
        vm.prank(P);e.withdraw();
        vm.expectRevert(E.Invalid.selector);fund();
    }
    function testP1DerivedIdMatchesDomainAndContract() public {
        bytes32 expected=keccak256(abi.encode(
            keccak256("TRANS_ATLAS_ESCROW_ID_V1"),uint256(31337),address(e),P,NONCE));
        ok(ID==expected);
        E other=new E(t,G,A,B,10000e6,100000e6,1 days,7 days);
        ok(other.deriveEscrowId(P,NONCE)!=ID);
        ok(e.deriveEscrowId(X,NONCE)!=ID);
        ok(e.deriveEscrowId(P,bytes32(uint256(99)))!=ID);
    }
    function testP1ZeroNonceRejected() public {
        vm.expectRevert(E.Invalid.selector);vm.prank(P);
        e.create(bytes32(0),C,AMOUNT,uint64(block.timestamp+1 days),uint64(block.timestamp+10 days),COM);
    }
}
