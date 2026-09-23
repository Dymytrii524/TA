"""Independent negative controls: each mutant must compile and fail its named test."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import json

root = Path(__file__).resolve().parents[1]
source = (root / "src/TransAtlasEscrow.sol").read_text()
cases = [
    ("payer-authority", "if (msg.sender != d.payer) revert Forbidden();", "",
     "testOnlyPayerApproves"),
    ("challenge-window", "if (block.timestamp < d.releaseAt) revert Deadline();", "",
     "testNoPrematureRelease"),
    ("chain-domain", "if (block.chainid != chainId) revert UnsupportedChain();", "",
     "testChainChangeRejected"),
    ("deposit-delta", "if (token.balanceOf(address(this)) != beforeBalance + amount) revert Invalid();", "",
     "testFeeTokenRejectedAtomically"),
    ("allocation", "claimable[d.carrier] += d.amount - payerAmount;",
     "claimable[d.carrier] += d.amount - payerAmount + 1;", "testFuzzConservation"),
    ("evidence-binding", "if (expectedEvidence != d.evidence) revert Invalid();", "",
     "testWrongEvidence"),
    ("payer-id-namespace", "id = deriveEscrowId(msg.sender, nonce);", "id = nonce;",
     "testP1AttackerCannotOccupyVictimId"),
]
results = []
env = {**os.environ, "FOUNDRY_FUZZ_RUNS": "32"}
for name, old, new, test in cases:
    assert source.count(old) == 1, name
    with tempfile.TemporaryDirectory(prefix="ta-mutant-") as folder:
        temp = Path(folder)
        for part in ("src", "test"):
            shutil.copytree(root / part, temp / part)
        shutil.copy2(root / "foundry.toml", temp / "foundry.toml")
        (temp / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
        # Mechanical mutation in disposable copy only, never in delivered source.
        (temp / "src/TransAtlasEscrow.sol").write_text(source.replace(old, new))
        p = subprocess.run(["node", str(root / "tools/foundry.mjs"),
                            "forge", "test", "--match-test", test, "-vv"], cwd=temp,
                           env=env, text=True, capture_output=True)
        detected = p.returncode != 0 and "[FAIL" in p.stdout and "Compiler run successful" in p.stdout
        results.append({"mutation": name, "test": test, "detected": detected, "exit_code": p.returncode})
        print(f"{'PASS' if detected else 'FAIL'} mutation {name}: {test} exit={p.returncode}")
        if not detected:
            print(p.stdout, p.stderr)
assert all(r["detected"] for r in results), "surviving/non-compiling mutation"
print(json.dumps({"mutations": results, "detected": len(results)}, indent=2))
