import json,re,copy,sys,os
from pathlib import Path
from jsonschema import Draft202012Validator
# Корінь репозиторію: каталог на рівень вище цього файлу. Абсолютний шлях тут
# неприпустимий — у CI скрипт мусить читати схему й ТЗ саме з поточної копії
# репозиторію, інакше перевірка валідує чужі файли й пропускає зміни в PR.
BASE = os.environ.get("CONTRACT_ROOT") or str(Path(__file__).resolve().parent.parent) + "/"
sch=json.load(open(BASE+'schemas/post-drone.schema.json'))
Draft202012Validator.check_schema(sch); v=Draft202012Validator(sch)
md=open(BASE+'ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md').read()
sec=md[md.index('#### A.8.4.1'):md.index('#### A.8.4.2')]
docs=dict(zip([f"T{n}" for n in range(16,28)],
  [json.loads(b.strip().replace('"..."','{"mode":"M"}')) for b in re.findall(r'```json\n(.*?)```',sec,re.S)]))
def errs(d): return list(v.iter_errors(d))
def add_drone(d,**kw):
    r={"route_id":"rt_1_d","origin":"post_drone","variant_of":"rt_1"}; r.update(kw)
    d.setdefault("routes",[]).append(r)
M={
 "T16":[("прибрано gate",lambda d:d["drone_diagnostics"][0].pop("gate")),
        ("невідомий код",lambda d:d["drone_diagnostics"][0].__setitem__("reason","wrong_mode")),
        ("дрон-варіант попри ворота 1",add_drone)],
 "T17":[("no_permit прибрано з warnings",lambda d:d["routes"][0].__setitem__("warnings",[])),
        ("gate=7",lambda d:d["drone_diagnostics"][0].__setitem__("gate",7))],
 "T18":[("порожня діагностика",lambda d:d.__setitem__("drone_diagnostics",[])),
        ("detail як рядок",lambda d:d["drone_diagnostics"][0].__setitem__("detail","42 км"))],
 "T19":[("зайве поле",lambda d:d["drone_diagnostics"][0].__setitem__("hint","x"))],
 "T20":[("пʼяте плече",lambda d:d["routes"][1]["legs"].append({"mode":"A"})),
        ("без variant_of",lambda d:d["routes"][1].pop("variant_of")),
        ("transships=4",lambda d:d["routes"][1].__setitem__("transships",4)),
        ("відʼємна дальність",lambda d:d["routes"][1]["legs"][2].__setitem__("range_used_km",-1))],
 "T21":[("без order_pinned_below",lambda d:d["routes"][1].pop("order_pinned_below")),
        ("order_pinned_below у гілки",lambda d:d["routes"][0].__setitem__("order_pinned_below","rt_0")),
        ("прапорець fog",lambda d:d["routes"][1].__setitem__("warnings",["fog"]))],
 "T22":[("variant_of у гілки",lambda d:d["routes"][0].__setitem__("variant_of","rt_0"))],
 "T23":[("без missing_leg",lambda d:d["drone_cta"].pop("missing_leg")),
        ("action=notify",lambda d:d["drone_cta"].__setitem__("action","notify")),
        ("mode=T у missing_leg",lambda d:d["drone_cta"]["missing_leg"].__setitem__("mode","T")),
        ("pad без відстані",lambda d:d["drone_cta"]["pad"].pop("distance_to_dest_km"))],
 "T24":[("drone_disabled із gate",lambda d:d["drone_diagnostics"][0].__setitem__("gate",1)),
        ("дрон-варіант при вимкненому модулі",add_drone)],
 "T25":[("без partial",lambda d:d.pop("partial")),
        ("partial=false",lambda d:d.__setitem__("partial",False)),
        ("дрон-варіант при таймауті",add_drone),
        ("drone_skipped=weather",lambda d:d.__setitem__("drone_skipped","weather"))],
 "T26":[("ok=null без source_error",lambda d:d["routes"][1]["legs"][1]["weather"].pop("source_error")),
        ("вигаданий вітер",lambda d:d["routes"][1]["legs"][1]["weather"].__setitem__("wind_ms",4)),
        ("без order_pinned_below",lambda d:d["routes"][1].pop("order_pinned_below"))],
 "T27":[("дрон-варіант у базі",lambda d:d["normalization_base"].append("rt_1_d")),
        ("база як рядок",lambda d:d.__setitem__("normalization_base","rt_1,rt_2"))],
}
# --- програмні перевірки, які не виражаються схемою (розділ A.8.4.3) ---
GATES_REFUSAL = (1, 2, 3, 4, 5)

def refused_parents(resp):
    """Маршрути, для яких ворота 1-5 дали відмову."""
    return {d["parent_route"] for d in resp.get("drone_diagnostics", [])
            if d.get("gate") in GATES_REFUSAL and "parent_route" in d}

def assert_no_variant_after_refusal(resp):
    """T16, T18, T19: відмова воріт 1-5 для rt_N виключає варіант з variant_of=rt_N.
    Загальна заборона дрон-варіантів тут неприпустима: відмова для rt_1 сумісна
    з наявністю варіанта для rt_2, тому звіряються саме пари parent_route/variant_of."""
    refused = refused_parents(resp)
    bad = [r["route_id"] for r in resp.get("routes", [])
           if r.get("variant_of") in refused]
    if bad:
        return (f"варіанти {bad} присутні, хоча ворота 1-5 відмовили "
                f"їхнім батьківським маршрутам {sorted(refused)}")

def assert_parent_present(resp):
    """Правило 2 розділу A.8.4: батьківський маршрут ніколи не видаляється з видачі."""
    ids = {r.get("route_id") for r in resp.get("routes", [])}
    orphans = [r["route_id"] for r in resp.get("routes", [])
               if r.get("variant_of") and r["variant_of"] not in ids]
    if orphans:
        return f"дрон-варіанти {orphans} без батьківського маршруту у видачі"

def assert_diag_parents_known(resp):
    """parent_route діагностики мусить існувати у видачі."""
    ids = {r.get("route_id") for r in resp.get("routes", [])}
    unknown = sorted({d["parent_route"] for d in resp.get("drone_diagnostics", [])
                      if "parent_route" in d and d["parent_route"] not in ids})
    if unknown:
        return f"діагностика посилається на невідомі маршрути {unknown}"

def assert_norm_base_matches(resp):
    """Розділ 7: normalization_base = рівно всі варіанти гілок видачі."""
    if "normalization_base" not in resp:
        return
    branch = {r["route_id"] for r in resp.get("routes", [])
              if r.get("origin") == "branch"}
    base = set(resp["normalization_base"])
    if base != branch:
        return (f"база нормалізації {sorted(base)} не збігається з набором "
                f"варіантів гілок {sorted(branch)}")

ASSERTS = {
    "T16": [assert_no_variant_after_refusal, assert_diag_parents_known],
    "T17": [assert_diag_parents_known, assert_parent_present],
    "T18": [assert_no_variant_after_refusal, assert_diag_parents_known],
    "T19": [assert_no_variant_after_refusal, assert_diag_parents_known],
    "T20": [assert_parent_present],
    "T21": [assert_parent_present],
    "T23": [assert_diag_parents_known],
    "T26": [assert_parent_present],
    "T27": [assert_norm_base_matches, assert_parent_present],
}

def run_asserts(name, resp):
    """Повертає перелік порушень для сценарію."""
    return [m for f in ASSERTS.get(name, []) if (m := f(resp))]

fail=0; rows=[]
for n,d in docs.items():
    pos = not errs(d)
    viol = run_asserts(n, d)
    fail += (not pos) + bool(viol)
    caught=[]; miss=[]
    for label,f in M[n]:
        m=copy.deepcopy(d); f(m)
        (caught if errs(m) else miss).append(label)
    # мутації, що ловляться лише програмними перевірками
    caught_by_asserts=[]
    for label,f in M[n]:
        if label in caught: continue
        m=copy.deepcopy(d); f(m)
        if run_asserts(n,m): caught_by_asserts.append(label)
    still = [x for x in miss if x not in caught_by_asserts]
    rows.append((n,pos,len(caught),len(caught_by_asserts),len(M[n]),still,viol))
    a = f"+{len(caught_by_asserts)} кодом" if caught_by_asserts else ""
    print(f"{n:4} позитив: {'OK' if pos and not viol else 'FAIL'}   "
          f"негатив: {len(caught)+len(caught_by_asserts)}/{len(M[n])} {a}"
          + (f"   НЕ ПОКРИТО: {', '.join(still)}" if still else "")
          + (f"   ПОРУШЕННЯ: {viol}" if viol else ""))
tot=sum(r[4] for r in rows); c=sum(r[2] for r in rows); a=sum(r[3] for r in rows)
gaps=sum(len(r[5]) for r in rows)
# --- порядок масиву routes (правило 6 розділу A.8.4) ---
def assert_routes_order(doc):
    """score зростає по масиву; виняток — варіант із order_pinned_below,
    який стоїть після свого батька навіть за меншого score."""
    rs = doc.get("routes", [])
    if any("score" not in r for r in rs):
        return []
    bad = []
    for a, b in zip(rs, rs[1:]):
        if b["score"] < a["score"] and "order_pinned_below" not in b:
            bad.append(f'{b["route_id"]} ({b["score"]}) після {a["route_id"]} ({a["score"]})')
    return bad

order_fail = 0
print("\nпорядок масиву routes:")
for name, d in docs.items():
    bad = assert_routes_order(d)
    if bad:
        order_fail += 1
        print(f"  {name}  ПОРУШЕННЯ: {'; '.join(bad)}")
print(f"  перевірено {len(docs)} сценаріїв, порушень: {order_fail}")

# --- покриття перерахувань схеми прикладами (виявлено прогоном у справжньому PR) ---
def enum_coverage():
    """Кожне значення reason мусить зустрічатися щонайменше в одному прикладі A.8.4.1.
    Інакше звуження перерахування (несумісна правка контракту) проходить CI
    непоміченим: схема стає строгішою, а жоден приклад цього не помічає."""
    declared = set(sch["$defs"]["reason"]["enum"])
    # Значення шукаються по всьому тексту розділу A.8.4.1, а не лише в json-блоках:
    # частина кодів наведена у пояснювальних абзацах як вбудовані фрагменти.
    used = {m for m in re.findall(r'"reason":\s*"([a-z_]+)"', sec)}
    used |= {m for m in re.findall(r'`reason`?: "([a-z_]+)"', sec)}
    used |= {m for m in re.findall(r'`([a-z_]+)`', sec) if m in declared}
    return declared - (used & declared), declared & used

uncovered, covered = enum_coverage()
print(f"\nпокриття кодів reason: {len(covered)}/{len(covered) + len(uncovered)}")
if uncovered:
    print(f"  НЕ ПОКРИТО прикладами: {', '.join(sorted(uncovered))}")

# --- самоперевірка програмних перевірок (щоб assert не був заглушкою) ---
SELF = [
 ("assert_no_variant_after_refusal", assert_no_variant_after_refusal,
  {"routes":[{"route_id":"rt_1","origin":"branch"},
             {"route_id":"rt_1_d","origin":"post_drone","variant_of":"rt_1"}],
   "drone_diagnostics":[{"parent_route":"rt_1","gate":3,"reason":"out_of_range"}]}),
 ("assert_no_variant_after_refusal (не спрацьовує на іншому маршруті)",
  lambda d: None if assert_no_variant_after_refusal(d) is None else "хибне спрацювання",
  {"routes":[{"route_id":"rt_1","origin":"branch"},{"route_id":"rt_2","origin":"branch"},
             {"route_id":"rt_2_d","origin":"post_drone","variant_of":"rt_2"}],
   "drone_diagnostics":[{"parent_route":"rt_1","gate":3,"reason":"out_of_range"}]}),
 ("assert_parent_present", assert_parent_present,
  {"routes":[{"route_id":"rt_1_d","origin":"post_drone","variant_of":"rt_9"}]}),
 ("assert_diag_parents_known", assert_diag_parents_known,
  {"routes":[{"route_id":"rt_1","origin":"branch"}],
   "drone_diagnostics":[{"parent_route":"rt_7","gate":1,"reason":"not_last_auto_leg"}]}),
 ("assert_norm_base_matches", assert_norm_base_matches,
  {"routes":[{"route_id":"rt_1","origin":"branch"},{"route_id":"rt_2","origin":"branch"}],
   "normalization_base":["rt_1"]}),
]
print("\nсамоперевірка перевірок:")
self_fail=0
for name,f,doc in SELF:
    got=f(doc)
    ok = got is None if "не спрацьовує" in name else got is not None
    self_fail += not ok
    print(f"  {'OK  ' if ok else 'FAIL'} {name}")

print(f"\nсценаріїв: {len(rows)}, помилок на позитивних прикладах: {fail}")
print(f"мутацій: {tot}, відхилено схемою: {c}, відхилено кодом: {a}, "
      f"не покрито: {gaps}, покриття: {(c+a)*100//tot}%")
sys.exit(1 if fail or gaps or self_fail or uncovered or order_fail else 0)
