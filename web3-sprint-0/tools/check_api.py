"""Validate API syntax, negative fixtures and drift against actual Solidity/SQL."""
from pathlib import Path
import json
import re
import subprocess
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from openapi_spec_validator import validate_spec

root = Path(__file__).resolve().parents[1]
doc = yaml.safe_load((root / "api/openapi.yaml").read_text())
validate_spec(doc)
resource = Resource.from_contents(doc, default_specification=__import__("referencing.jsonschema", fromlist=["DRAFT202012"]).DRAFT202012)
registry = Registry().with_resource("urn:ta:web3", resource)
validator = Draft202012Validator(
    {"$ref": "urn:ta:web3#/components/schemas/IntentRequest"}, registry=registry
)
h = "0x" + "ab" * 32
positive = [
    {"action": "create", "chain_id": 31337, "terms_version": 2},
    {"action": "accept", "chain_id": 80002, "expected_terms_hash": h},
    {"action": "approveDelivery", "chain_id": 31337, "evidence_commitment": h},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "123456"},
    {"action": "dispute", "chain_id": 31337, "reason_commitment": h},
]
negative = [
    {"action": "create", "chain_id": 31337},
    {"action": "create", "chain_id": 31337, "terms_version": 1},
    {"action": "withdraw", "chain_id": 31337},
    {"action": "create", "chain_id": 137, "terms_version": 2},
    {"action": "accept", "chain_id": 31337},
    {"action": "approveDelivery", "chain_id": 31337},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": 10},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "-1"},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "1.5"},
    {"action": "dispute", "chain_id": 31337},
    {"action": "create", "chain_id": 31337, "terms_version": 2, "private_key": "forbidden"},
    {"action": "create", "chain_id": 31337, "terms_version": 2, "escrow_id": h},
    {"action": "create", "chain_id": 31337, "terms_version": 2, "escrow_nonce": h},
]
for value in positive:
    validator.validate(value)
for value in negative:
    assert list(validator.iter_errors(value)), f"negative fixture passed: {value}"
wallet_validator = Draft202012Validator(
    {"$ref": "urn:ta:web3#/components/schemas/WalletIntentRequest"}, registry=registry)
wallet_validator.validate({"action": "withdraw", "chain_id": 31337})
for invalid in [{"action":"withdraw","chain_id":137},
                {"action":"withdraw","chain_id":31337,"deal_id":"x"},
                {"action":"withdraw","chain_id":31337,"amount":"1"},
                {"action":"create","chain_id":31337}]:
    assert not wallet_validator.is_valid(invalid)

# C03: validate full response objects, then check the SAME data pattern in JS.
calldata_cases = json.loads((root / "tests/fixtures/calldata.json").read_text())
response_validator = Draft202012Validator(
    {"$ref": "urn:ta:web3#/components/schemas/TransactionIntent"}, registry=registry
)
response = {
    "intent_id": "00000000-0000-4000-8000-000000000001", "chain_id": 31337,
    "from": "0x" + "1" * 40, "to": "0x" + "2" * 40,
    "value_atomic": "0", "expires_at": "2030-01-01T00:00:00Z", "broadcast": False,
}
for case in calldata_cases:
    accepted = response_validator.is_valid({**response, "data": case["data"]})
    assert accepted == case["valid"], f"C03 response fixture: {case['name']}"
assert not response_validator.is_valid(response), "calldata must remain required"
data_schema = doc["components"]["schemas"]["TransactionIntent"]["properties"]["data"]
subprocess.run(
    ["node", str(root / "tests/api-calldata.test.mjs")],
    input=json.dumps(data_schema), text=True, check=True,
)
# Negative controls: prove fixtures detect both the original odd-hex defect
# and the tempting even-byte '$' pattern that still admits final LF in Python.
for pattern, witness in [
    (r"^0x[0-9a-f]*$", "odd-one-nibble"),
    (r"^0x(?:[0-9a-f]{2})*$", "final-lf"),
]:
    case = next(c for c in calldata_cases if c["name"] == witness)
    mutant = Draft202012Validator({**data_schema, "pattern": pattern})
    assert not case["valid"] and mutant.is_valid(case["data"]), f"undetected mutation: {witness}"
print(f"PASS C03 Python response validation: {sum(c['valid'] for c in calldata_cases)} positive, "
      f"{sum(not c['valid'] for c in calldata_cases)} negative; missing data rejected; 2 regex mutations detected.")
sol = (root / "src/TransAtlasEscrow.sol").read_text()
assert re.search(r"function create\(\s*bytes32 nonce,", sol)
assert 'id = deriveEscrowId(msg.sender, nonce);' in sol
assert 'escrow_nonce' in doc["components"]["schemas"]["TransactionIntent"]["properties"]
sql = (root / "db/001_web3.sql").read_text()
states = [v.strip().upper() for v in re.search(r"enum State \{([^}]+)", sol)[1].split(",")][1:]
assert states == doc["components"]["schemas"]["State"]["enum"]
sql_states = re.findall(r"'([^']+)'", re.search(r"CREATE TYPE web3.escrow_state AS ENUM \(([^)]+)", sql)[1])
assert states == sql_states
actions = doc["components"]["schemas"]["IntentRequest"]["properties"]["action"]["enum"]
assert doc["components"]["schemas"]["Escrow"]["properties"]["review_period_seconds"]["const"] == 172800
assert 'uint64 public constant reviewPeriod = 48 hours;' in sol
assert 'TRANS_ATLAS_TERMS_V2' in sol and 'uint16 termsVersion' in sol
abi = json.loads((root / "artifacts/TransAtlasEscrow.abi.json").read_text())
create = next(item for item in abi if item.get("type") == "function" and item.get("name") == "create")
assert create["inputs"][-1] == {"name":"termsVersion","type":"uint16","internalType":"uint16"}
for action in actions:
    assert re.search(rf"function {action}\(", sol), action
for path, item in doc["paths"].items():
    for verb, op in item.items():
        if verb == "post":
            assert {"$ref": "#/components/parameters/IdempotencyKey"} in op["parameters"], path
print(f"PASS OpenAPI 3.1; {len(positive)} positive, {len(negative)} negative fixtures; "
      f"Solidity/SQL/API state parity; {len(actions)} function mappings; all POST idempotency headers.")
