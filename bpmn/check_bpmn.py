#!/usr/bin/env python3
"""Структурна перевірка BPMN-діаграм check-call (bpmn/*.bpmn).

Діаграми - проєкт процесу, а не працюючий сервіс, але сам проєкт можна перевірити:
посилання не висять, кожен шлях доходить до кінця, лейни повні, у діаграмі (BPMNDI) є
фігура для кожного вузла. Перевірка НЕ доводить, що процес правильний за змістом,
лише що діаграма структурно цілісна.

Запуск із кореня репозиторію:  python bpmn/check_bpmn.py
Самоперевірка:  python bpmn/check_bpmn.py --self-test   (мутації мають бути виявлені)
"""
import copy
import pathlib
import sys
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

NS = {"b": "http://www.omg.org/spec/BPMN/20100524/MODEL", "di": "http://www.omg.org/spec/BPMN/20100524/DI"}
B = "{%s}" % NS["b"]
DI = "{%s}" % NS["di"]
FLOW_NODES = ("startEvent", "endEvent", "task", "exclusiveGateway", "parallelGateway", "intermediateCatchEvent",
              "intermediateThrowEvent", "boundaryEvent", "subProcess", "userTask", "serviceTask", "manualTask")
ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ["bpmn/checkcall.bpmn", "bpmn/checkcall-exception.bpmn"]
SVG = {"bpmn/checkcall.bpmn": "images/checkcall-bpmn.svg", "bpmn/checkcall-exception.bpmn": "images/checkcall-exception-subprocess.svg"}


def local(tag):
    return tag.split("}")[-1]


def scopes(root):
    """Кожен process і subProcess - окремий контур: потоки не перетинають його меж."""
    out = []
    for el in root.iter():
        if local(el.tag) in ("process", "subProcess"):
            out.append(el)
    return out


def check_tree(root, svg_text=None):
    """Повертає список помилок для одного дерева BPMN."""
    errs = []
    all_ids = {}
    for el in root.iter():
        i = el.get("id")
        if i:
            if i in all_ids:
                errs.append(f"повторний id {i}")
            all_ids[i] = el

    shapes = {e.get("bpmnElement") for e in root.iter(DI + "BPMNShape")}
    edges = {e.get("bpmnElement") for e in root.iter(DI + "BPMNEdge")}

    for ref in sorted((shapes | edges) - set(all_ids)):
        errs.append(f"BPMNDI посилається на неіснуючий елемент {ref}")

    for sc in scopes(root):
        sid = sc.get("id")
        nodes = {c.get("id"): c for c in sc if local(c.tag) in FLOW_NODES}
        flows = {c.get("id"): c for c in sc if local(c.tag) == "sequenceFlow"}
        # boundaryEvent лежить у тому ж контурі, що й задача, до якої прикріплений
        for fid, f in flows.items():
            for end in ("sourceRef", "targetRef"):
                if f.get(end) not in nodes:
                    errs.append(f"{sid}: потік {fid} має {end}={f.get(end)}, якого немає в контурі")
        inc = {n: [] for n in nodes}
        out = {n: [] for n in nodes}
        for fid, f in flows.items():
            if f.get("sourceRef") in out:
                out[f.get("sourceRef")].append(fid)
            if f.get("targetRef") in inc:
                inc[f.get("targetRef")].append(fid)
        for nid, n in nodes.items():
            kind = local(n.tag)
            declared_in = sorted(e.text for e in n.findall("b:incoming", NS))
            declared_out = sorted(e.text for e in n.findall("b:outgoing", NS))
            if declared_in != sorted(inc[nid]):
                errs.append(f"{sid}: {nid} - incoming {declared_in} не збігається з потоками {sorted(inc[nid])}")
            if declared_out != sorted(out[nid]):
                errs.append(f"{sid}: {nid} - outgoing {declared_out} не збігається з потоками {sorted(out[nid])}")
            if kind not in ("startEvent", "boundaryEvent") and not inc[nid]:
                errs.append(f"{sid}: {nid} ({kind}) не має вхідного потоку")
            if kind != "endEvent" and not out[nid]:
                errs.append(f"{sid}: {nid} ({kind}) - глухий кут: немає вихідного потоку")
            if kind == "exclusiveGateway" and len(out[nid]) > 1:
                unnamed = [f for f in out[nid] if not flows[f].get("name") and n.get("default") != f]
                if unnamed:
                    errs.append(f"{sid}: {nid} - виходи шлюзу без назви умови: {unnamed}")
            if kind == "boundaryEvent" and n.get("attachedToRef") not in nodes:
                errs.append(f"{sid}: {nid} прикріплений до {n.get('attachedToRef')}, якого немає")
            if nid not in shapes:
                errs.append(f"{sid}: для {nid} немає фігури в BPMNDI")
        for fid in flows:
            if fid not in edges:
                errs.append(f"{sid}: для потоку {fid} немає лінії в BPMNDI")

        starts = [n for n, e in nodes.items() if local(e.tag) == "startEvent"]
        ends = [n for n, e in nodes.items() if local(e.tag) == "endEvent"]
        if not starts:
            errs.append(f"{sid}: немає startEvent")
        if not ends:
            errs.append(f"{sid}: немає endEvent")
        succ = {n: [] for n in nodes}
        for f in flows.values():
            if f.get("sourceRef") in succ and f.get("targetRef") in nodes:
                succ[f.get("sourceRef")].append(f.get("targetRef"))
        for nid, n in nodes.items():                        # boundary: продовжує від задачі, до якої прикріплений
            if local(n.tag) == "boundaryEvent" and n.get("attachedToRef") in succ:
                succ[n.get("attachedToRef")].append(nid)
        starts_all = set(starts) | {n for n, e in nodes.items() if local(e.tag) == "boundaryEvent"}
        reach, stack = set(), list(starts_all)
        while stack:
            x = stack.pop()
            if x in reach:
                continue
            reach.add(x)
            stack.extend(succ.get(x, []))
        for nid in nodes:
            if nid not in reach:
                errs.append(f"{sid}: {nid} недосяжний зі старту")
        pred = {n: [] for n in nodes}
        for a, bs in succ.items():
            for b in bs:
                pred[b].append(a)
        back, stack = set(), list(ends)
        while stack:
            x = stack.pop()
            if x in back:
                continue
            back.add(x)
            stack.extend(pred.get(x, []))
        for nid in nodes:
            if nid not in back:
                errs.append(f"{sid}: з {nid} не можна дійти до жодного endEvent")

        for lane in sc.iter(B + "lane"):
            for ref in lane.findall("b:flowNodeRef", NS):
                if ref.text not in all_ids:
                    errs.append(f"лейн {lane.get('id')}: flowNodeRef {ref.text} не існує")

    # кожен вузол верхнього контуру належить рівно одному лейну
    for proc in root.findall("b:process", NS):
        lanes = list(proc.iter(B + "lane"))
        if lanes:
            count = {}
            for lane in lanes:
                for ref in lane.findall("b:flowNodeRef", NS):
                    count[ref.text] = count.get(ref.text, 0) + 1
            for c in proc:
                if local(c.tag) in FLOW_NODES and local(c.tag) != "boundaryEvent" and count.get(c.get("id"), 0) != 1:
                    errs.append(f"{proc.get('id')}: {c.get('id')} у {count.get(c.get('id'), 0)} лейнах, потрібен рівно один")

    if svg_text is not None:
        # у SVG основного процесу підпроцес згорнутий: його внутрішні вузли лежать у другій діаграмі
        top = [c for proc in root.findall("b:process", NS) for c in proc]
        for el in top:
            if local(el.tag) in ("task", "subProcess", "startEvent", "endEvent") and el.get("name"):
                words = el.get("name").split()
                if words and words[0] not in svg_text:
                    errs.append(f"SVG не містить назви вузла {el.get('id')} ({el.get('name')})")
    return errs


def load(rel):
    return ET.parse(ROOT / rel).getroot()


def run_all():
    total = 0
    for rel in FILES:
        root = load(rel)
        svg = (ROOT / SVG[rel]).read_text(encoding="utf-8") if (ROOT / SVG[rel]).exists() else None
        errs = check_tree(root, svg)
        nodes = sum(1 for e in root.iter() if local(e.tag) in FLOW_NODES)
        flows = sum(1 for e in root.iter() if local(e.tag) == "sequenceFlow")
        lanes = sum(1 for e in root.iter() if local(e.tag) == "lane")
        if svg is None:
            errs.append(f"немає {SVG[rel]}")
        print(f"{'OK  ' if not errs else 'ПРОВАЛ'} {rel}: вузлів {nodes}, потоків {flows}, лейнів {lanes}")
        for e in errs:
            print("      ", e)
        total += len(errs)
    return total


def self_test():
    """Мутації: перевірка, яка їх не помічає, нічого не варта."""
    base = load(FILES[0])
    results = []

    def mutate(name, fn):
        t = copy.deepcopy(base)
        fn(t)
        results.append((name, bool(check_tree(t))))

    def drop_target(t):
        for f in t.iter(B + "sequenceFlow"):
            f.set("targetRef", "no_such_node")
            return

    def remove_flow(t):
        for p in t.iter(B + "process"):
            for f in list(p.findall("b:sequenceFlow", NS))[3:4]:
                p.remove(f)

    def orphan_node(t):
        p = next(t.iter(B + "process"))
        ET.SubElement(p, B + "task", {"id": "t_orphan", "name": "Сирота"})

    def duplicate_id(t):
        els = [e for e in t.iter() if e.get("id") and local(e.tag) == "task"]
        els[1].set("id", els[0].get("id"))

    def lane_ref(t):
        for r in t.iter(B + "flowNodeRef"):
            r.text = "ghost"
            return

    def drop_shape(t):
        for s in t.iter(DI + "BPMNShape"):
            s.set("bpmnElement", "ghost_shape")
            return

    def unnamed_gateway_exit(t):
        for g in t.iter(B + "exclusiveGateway"):
            gid = g.get("id")
            for f in t.iter(B + "sequenceFlow"):
                if f.get("sourceRef") == gid and f.get("name"):
                    del f.attrib["name"]
                    return

    for name, fn in [("потік на неіснуючий вузол", drop_target), ("вилучений потік", remove_flow), ("вузол-сирота", orphan_node),
                     ("повторний id", duplicate_id), ("лейн посилається на неіснуючий вузол", lane_ref),
                     ("фігура BPMNDI без вузла", drop_shape), ("вихід шлюзу без умови", unnamed_gateway_exit)]:
        mutate(name, fn)
    ok = 0
    for name, caught in results:
        print(("виявлено   " if caught else "НЕ ВИЯВЛЕНО"), name)
        ok += caught
    print(f"\nмутацій: {len(results)}, виявлено: {ok}")
    return len(results) - ok


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(1 if self_test() else 0)
    bad = run_all()
    print(f"\nпомилок: {bad}")
    sys.exit(1 if bad else 0)
