import json, sys, yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
doc=yaml.safe_load(open("api/openapi.yaml"))
reg=Registry().with_resource("urn:ta:web3",Resource.from_contents(doc,default_specification=DRAFT202012))
values=json.load(sys.stdin)
assert values
for item in values:
    path = "components/responses/Unavailable/content/application~1problem+json/schema" if item["status"]==503 else "components/schemas/Problem"
    Draft202012Validator({"$ref":"urn:ta:web3#/"+path}, registry=reg,
                        format_checker=FormatChecker()).validate(item["body"])
    assert item["body"]["status"]==item["status"]
print(f"PASS full problem response schemas: {len(values)} actual HTTP errors")
