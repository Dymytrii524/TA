"""Validate actual HTTP response bodies piped by the EVM regression."""
import sys, json, yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
doc = yaml.safe_load(open("api/openapi.yaml"))
reg = Registry().with_resource("urn:ta:web3", Resource.from_contents(doc, default_specification=DRAFT202012))
v = Draft202012Validator({"$ref":"urn:ta:web3#/components/schemas/WalletClaims"},
                        registry=reg, format_checker=FormatChecker())
values = json.load(sys.stdin)
assert values
for value in values:
    v.validate(value)
    assert int(value["claimable_atomic"]) == sum(int(value[k]) for k in
        ("ta_claimable_atomic","unattributed_claimable_atomic","restricted_claimable_atomic"))
print(f"PASS full WalletClaims schema and partition sums: {len(values)} actual HTTP responses")
