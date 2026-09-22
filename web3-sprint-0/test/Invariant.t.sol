// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TransAtlasEscrow as E} from "../src/TransAtlasEscrow.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {TestBase} from "./TestBase.sol";

contract Handler is TestBase {
    E public e;
    MockUSDC public t;
    uint256 public counter;
    uint256 public successfulTransitions;
    uint256 public successfulWithdrawals;
    uint256 public ghostDeposits;
    uint256 public ghostWithdrawals;
    address public constant P=address(201);
    address public constant C=address(202);
    address public constant A=address(204);
    address public constant B=address(205);
    bytes32 constant COM=keccak256("commitment");
    bytes32[] public ids;
    constructor(E e_, MockUSDC t_) { e=e_; t=t_; }
    function create(uint96 raw) external {
        uint256 amount=uint256(raw)%10000e6+1;
        if(e.locked()+e.totalClaimable()+amount>e.maxLiability()) return;
        bytes32 id=bytes32(++counter);
        t.mint(P,amount);
        vm.startPrank(P);
        t.approve(address(e),amount);
        e.create(id,C,amount,uint64(block.timestamp+1 days),uint64(block.timestamp+3 days),COM);
        vm.stopPrank();
        ids.push(id); ghostDeposits+=amount; successfulTransitions++;
    }
    function step(uint256 choice,uint96 split,bool challenge) external {
        if(ids.length==0) return;
        bytes32 id=ids[choice%ids.length];
        E.Deal memory d=e.getDeal(id);
        if(d.state==E.State.Funded){
            if(block.timestamp>d.acceptBy){ vm.prank(P); e.cancelUnaccepted(id); }
            else { vm.prank(C); e.accept(id,d.termsHash); }
        } else if(d.state==E.State.Active || d.state==E.State.Delivered){
            if(block.timestamp>d.deliveryBy){ e.escalateOverdue(id); }
            else if(challenge){ vm.prank(P); e.dispute(id,COM); }
            else if(d.state==E.State.Active){ vm.prank(C); e.submitDelivery(id,COM); }
            else { vm.prank(P); e.approveDelivery(id,COM); }
        } else if(d.state==E.State.Accepted){
            if(block.timestamp>=d.releaseAt) e.finalize(id);
            else if(challenge){ vm.prank(C); e.dispute(id,COM); }
            else return;
        } else if(d.state==E.State.Disputed){
            address resolver=block.timestamp<uint256(d.disputedAt)+e.arbitrationPeriod()?A:B;
            vm.prank(resolver); e.resolve(id,uint256(split)%(d.amount+1));
        } else return;
        successfulTransitions++;
    }
    function advance(uint32 raw) external { vm.warp(block.timestamp+uint256(raw)%4 days); }
    function withdraw(bool payer) external {
        address who=payer?P:C;
        uint256 amount=e.claimable(who);
        if(amount==0) return;
        vm.prank(who); e.withdraw();
        ghostWithdrawals+=amount; successfulWithdrawals++;
    }
    function count() external view returns(uint256){ return ids.length; }
}

contract EscrowInvariantTest is TestBase {
    E e; MockUSDC t; Handler h;
    address[] private targets;
    function setUp() public {
        vm.chainId(31337); vm.warp(100000);
        t=new MockUSDC();
        e=new E(t,address(203),address(204),address(205),10000e6,1000000e6,1 days,7 days);
        h=new Handler(e,t); targets.push(address(h));
        // Seed a real lifecycle so invariants do not only exercise empty state.
        h.create(1000e6); h.step(0,0,false); h.step(0,0,false);
        h.step(0,0,false); h.advance(2 days); h.step(0,0,false); h.withdraw(false);
    }
    function targetContracts() external view returns(address[] memory){ return targets; }
    function invariantConservation() public view {
        eq(h.ghostDeposits(),e.totalDeposited());
        eq(h.ghostWithdrawals(),e.totalWithdrawn());
        eq(h.ghostDeposits(),h.ghostWithdrawals()+e.locked()+e.totalClaimable());
    }
    function invariantSolvent() public view {
        eq(t.balanceOf(address(e)),e.locked()+e.totalClaimable());
        eq(e.totalClaimable(),e.claimable(h.P())+e.claimable(h.C()));
    }
    function invariantLockedMatchesDeals() public view {
        uint256 sum;
        for(uint256 i;i<h.count();i++){
            E.Deal memory d=e.getDeal(h.ids(i));
            if(d.state!=E.State.Settled) sum+=d.amount;
        }
        eq(e.locked(),sum);
        ok(h.successfulTransitions()>=5);
        ok(h.successfulWithdrawals()>=1);
    }
}
