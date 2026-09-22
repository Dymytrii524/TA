// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice LOCAL / AMOY ONLY. Not audited. No fees, upgrades, rescue or arbitrary payouts.
/// @dev Wallet transactions, not off-chain signatures, authorize every transition.
contract TransAtlasEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { None, Funded, Active, Delivered, Accepted, Disputed, Settled }
    struct Deal {
        address payer;
        address carrier;
        uint256 amount;
        uint64 acceptBy;
        uint64 deliveryBy;
        uint64 releaseAt;
        uint64 disputedAt;
        State state;
        bytes32 termsHash;
        bytes32 evidence;
    }

    IERC20 public immutable token;
    address public immutable guardian;
    address public immutable arbiter;
    address public immutable backupArbiter;
    uint256 public immutable chainId;
    uint256 public immutable maxPerDeal;
    uint256 public immutable maxLiability;
    uint64 public immutable challengePeriod;
    uint64 public immutable arbitrationPeriod;
    bool public intakePaused;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public locked;
    uint256 public totalClaimable;
    mapping(bytes32 => Deal) private _deals;
    mapping(address => uint256) public claimable;

    error Forbidden();
    error Invalid();
    error WrongState();
    error Deadline();
    error Paused();
    error UnsupportedChain();

    event Funded(bytes32 indexed id, address indexed payer, address indexed carrier,
        uint256 amount, bytes32 termsHash);
    event StateChanged(bytes32 indexed id, State state);
    event EvidenceSubmitted(bytes32 indexed id, bytes32 commitment);
    event Accepted(bytes32 indexed id, uint64 releaseAt);
    event Disputed(bytes32 indexed id, bytes32 reasonCommitment);
    event Settled(bytes32 indexed id, uint256 payerAmount, uint256 carrierAmount);
    event Withdrawn(address indexed account, uint256 amount);
    event IntakePause(bool paused);

    modifier correctChain() {
        if (block.chainid != chainId) revert UnsupportedChain();
        _;
    }

    constructor(
        IERC20 token_, address guardian_, address arbiter_, address backup_,
        uint256 maxPerDeal_, uint256 maxLiability_,
        uint64 challengePeriod_, uint64 arbitrationPeriod_
    ) {
        if (block.chainid != 31337 && block.chainid != 80002) revert UnsupportedChain();
        if (address(token_).code.length == 0 || guardian_ == address(0)
            || arbiter_ == address(0) || backup_ == address(0)
            || guardian_ == arbiter_ || guardian_ == backup_ || arbiter_ == backup_
            || maxPerDeal_ == 0 || maxLiability_ < maxPerDeal_
            || challengePeriod_ < 1 hours || challengePeriod_ > 30 days
            || arbitrationPeriod_ < 1 days || arbitrationPeriod_ > 30 days) revert Invalid();
        // On Amoy only the Circle-documented test USDC is accepted.
        if (block.chainid == 80002 &&
            address(token_) != address(uint160(0x0041e94eb019c0762f9bfcf9fb1e58725bfb0e7582))) revert Invalid();
        token = token_;
        guardian = guardian_;
        arbiter = arbiter_;
        backupArbiter = backup_;
        chainId = block.chainid;
        maxPerDeal = maxPerDeal_;
        maxLiability = maxLiability_;
        challengePeriod = challengePeriod_;
        arbitrationPeriod = arbitrationPeriod_;
    }

    function getDeal(bytes32 id) external view returns (Deal memory) { return _deals[id]; }

    function setIntakePaused(bool value) external correctChain {
        if (msg.sender != guardian) revert Forbidden();
        intakePaused = value;
        emit IntakePause(value);
    }

    function create(
        bytes32 id, address carrier, uint256 amount, uint64 acceptBy,
        uint64 deliveryBy, bytes32 agreementCommitment
    ) external nonReentrant correctChain {
        if (intakePaused) revert Paused();
        if (id == bytes32(0) || _deals[id].state != State.None
            || carrier == address(0) || carrier == msg.sender || carrier == address(this)
            || carrier == arbiter || carrier == backupArbiter
            || msg.sender == arbiter || msg.sender == backupArbiter
            || amount == 0 || amount > maxPerDeal
            || locked + totalClaimable + amount > maxLiability
            || acceptBy <= block.timestamp || deliveryBy <= acceptBy
            || agreementCommitment == bytes32(0)) revert Invalid();
        bytes32 terms = keccak256(abi.encode(
            chainId, address(this), id, msg.sender, carrier, address(token), amount,
            acceptBy, deliveryBy, agreementCommitment, arbiter, backupArbiter,
            challengePeriod, arbitrationPeriod
        ));
        _deals[id] = Deal(msg.sender, carrier, amount, acceptBy, deliveryBy,
            0, 0, State.Funded, terms, bytes32(0));
        locked += amount;
        totalDeposited += amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        // Reject fee-on-transfer / underfunded deposits. Whole transaction reverts.
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert Invalid();
        emit Funded(id, msg.sender, carrier, amount, terms);
        emit StateChanged(id, State.Funded);
    }

    function accept(bytes32 id, bytes32 expectedTerms) external correctChain {
        Deal storage d = _deals[id];
        if (msg.sender != d.carrier) revert Forbidden();
        if (d.state != State.Funded) revert WrongState();
        if (block.timestamp > d.acceptBy) revert Deadline();
        if (expectedTerms != d.termsHash) revert Invalid();
        d.state = State.Active;
        emit StateChanged(id, d.state);
    }

    function cancelUnaccepted(bytes32 id) external correctChain {
        Deal storage d = _deals[id];
        if (d.state != State.Funded) revert WrongState();
        // Carrier may decline. Payer must wait until acceptance deadline expires.
        if (msg.sender != d.carrier &&
            (msg.sender != d.payer || block.timestamp <= d.acceptBy)) revert Forbidden();
        _settle(id, d, d.amount);
    }

    function submitDelivery(bytes32 id, bytes32 evidenceCommitment) external correctChain {
        Deal storage d = _deals[id];
        if (msg.sender != d.carrier) revert Forbidden();
        if (d.state != State.Active) revert WrongState();
        if (block.timestamp > d.deliveryBy) revert Deadline();
        if (evidenceCommitment == bytes32(0)) revert Invalid();
        d.evidence = evidenceCommitment;
        d.state = State.Delivered;
        emit EvidenceSubmitted(id, evidenceCommitment);
        emit StateChanged(id, d.state);
    }

    function approveDelivery(bytes32 id, bytes32 expectedEvidence) external correctChain {
        Deal storage d = _deals[id];
        if (msg.sender != d.payer) revert Forbidden();
        if (d.state != State.Delivered) revert WrongState();
        if (block.timestamp > d.deliveryBy) revert Deadline();
        if (expectedEvidence != d.evidence) revert Invalid();
        d.releaseAt = uint64(block.timestamp) + challengePeriod;
        d.state = State.Accepted;
        emit Accepted(id, d.releaseAt);
        emit StateChanged(id, d.state);
    }

    function dispute(bytes32 id, bytes32 reasonCommitment) external correctChain {
        Deal storage d = _deals[id];
        if (msg.sender != d.payer && msg.sender != d.carrier) revert Forbidden();
        if (d.state != State.Active && d.state != State.Delivered && d.state != State.Accepted)
            revert WrongState();
        // Exact boundary belongs to finalize, not dispute.
        if (d.state == State.Accepted && block.timestamp >= d.releaseAt) revert Deadline();
        if (reasonCommitment == bytes32(0)) revert Invalid();
        _dispute(id, d, reasonCommitment);
    }

    function escalateOverdue(bytes32 id) external correctChain {
        Deal storage d = _deals[id];
        if (d.state != State.Active && d.state != State.Delivered) revert WrongState();
        if (block.timestamp <= d.deliveryBy) revert Deadline();
        _dispute(id, d, keccak256("OVERDUE"));
    }

    function finalize(bytes32 id) external correctChain {
        Deal storage d = _deals[id];
        if (d.state != State.Accepted) revert WrongState();
        if (block.timestamp < d.releaseAt) revert Deadline();
        _settle(id, d, 0);
    }

    function resolve(bytes32 id, uint256 payerAmount) external correctChain {
        Deal storage d = _deals[id];
        if (d.state != State.Disputed) revert WrongState();
        address authorized = block.timestamp < uint256(d.disputedAt) + arbitrationPeriod
            ? arbiter : backupArbiter;
        if (msg.sender != authorized) revert Forbidden();
        if (payerAmount > d.amount) revert Invalid();
        _settle(id, d, payerAmount);
    }

    function withdraw() external nonReentrant correctChain {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert Invalid();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        totalWithdrawn += amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _dispute(bytes32 id, Deal storage d, bytes32 reason) private {
        d.state = State.Disputed;
        d.disputedAt = uint64(block.timestamp);
        emit Disputed(id, reason);
        emit StateChanged(id, d.state);
    }

    function _settle(bytes32 id, Deal storage d, uint256 payerAmount) private {
        d.state = State.Settled;
        locked -= d.amount;
        totalClaimable += d.amount;
        claimable[d.payer] += payerAmount;
        claimable[d.carrier] += d.amount - payerAmount;
        emit Settled(id, payerAmount, d.amount - payerAmount);
        emit StateChanged(id, d.state);
    }
}
