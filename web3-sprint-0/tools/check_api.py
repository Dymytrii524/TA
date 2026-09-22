"""Validate API syntax, negative fixtures and drift against actual Solidity/SQL."""
from pathlib import Path
import re
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
    {"action": "create", "chain_id": 31337},
    {"action": "accept", "chain_id": 80002, "expected_terms_hash": h},
    {"action": "approveDelivery", "chain_id": 31337, "evidence_commitment": h},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "123456"},
    {"action": "dispute", "chain_id": 31337, "reason_commitment": h},
]
negative = [
    {"action": "create", "chain_id": 137},
    {"action": "accept", "chain_id": 31337},
    {"action": "approveDelivery", "chain_id": 31337},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": 10},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "-1"},
    {"action": "resolve", "chain_id": 31337, "payer_amount_atomic": "1.5"},
    {"action": "dispute", "chain_id": 31337},
    {"action": "create", "chain_id": 31337, "private_key": "forbidden"},
    {"action": "create", "chain_id": 31337, "escrow_id": h},
    {"action": "create", "chain_id": 31337, "escrow_nonce": h},
]
for value in positive:
    validator.validate(value)
for value in negative:
    assert list(validator.iter_errors(value)), f"negative fixture passed: {value}"
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
for action in actions:
    assert re.search(rf"function {action}\(", sol), action
for path, item in doc["paths"].items():
    for verb, op in item.items():
        if verb == "post":
            assert {"$ref": "#/components/parameters/IdempotencyKey"} in op["parameters"], path
print(f"PASS OpenAPI 3.1; {len(positive)} positive, {len(negative)} negative fixtures; "
      f"Solidity/SQL/API state parity; {len(actions)} function mappings; all POST idempotency headers.")
