# -*- coding: utf-8 -*-
"""Чотири файли з однієї моделі: основний процес check-call + підпроцес
«Обробка винятків» (SVG-ілюстрації), плюс BPMN 2.0 XML з drill-down у
підпроцес і колаборація підпроцесу з message flows до контрагентів.
Вихід: checkcall-bpmn.svg, checkcall-exception-subprocess.svg,
checkcall.bpmn, checkcall-exception.bpmn."""
import textwrap, html, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

W_T, H_T = 160, 74
S_G, S_E, S_B = 52, 38, 38
W_S, H_S = 220, 100

FONT = "Inter, 'Segoe UI', Arial, sans-serif"
INK = "#1c2b3a"
SUB_INK = "#44586d"
ACC = {"lane_sys": "#0f6fbf", "lane_ai": "#7b4bd1", "lane_disp": "#c2711b", "sub": "#c2711b"}
FILL = {"lane_sys": "#eaf3fb", "lane_ai": "#f2edfd", "lane_disp": "#fdf2e4", "sub": "#fdf2e4"}

LANES = [
    ("lane_sys", "Оркестратор трекінгу (система)", 60, 320),
    ("lane_ai", "AI check-call агент", 380, 250),
    ("lane_disp", "Диспетчер (людина)", 630, 240),
]
POOL_X, POOL_W, POOL_Y, POOL_H, LANE_HDR = 40, 1990, 60, 810, 34

# ---------------------------------------------------------------- основний процес
MAIN = {
    "e_start":  ("start", "Вантаж призначено перевізнику", 200, 120, "lane_sys"),
    "t_plan":   ("task", "Активувати план трекінгу: геозони, вікна, частота", 360, 120, "lane_sys"),
    "e_timer":  ("timer", "Інтервал моніторингу", 480, 120, "lane_sys"),
    "t_pos":    ("task", "Отримати позицію: ELD / GPS / застосунок водія", 610, 120, "lane_sys"),
    "g_fresh":  ("gw", "Дані актуальні?", 745, 120, "lane_sys"),
    "g_dev":    ("gw", "Відхилення від плану?", 860, 120, "lane_sys"),
    "t_upd":    ("task", "Оновити статус у TMS і сповістити клієнта", 1400, 120, "lane_sys"),
    "e_geo":    ("msgstart", "Геозона: прибуття або виїзд", 200, 232, "lane_sys"),
    "t_geo":    ("task", "Авто check-in / check-out, timestamp, сповіщення", 360, 232, "lane_sys"),
    "g_dlv":    ("gw", "Це доставка?", 480, 232, "lane_sys"),
    "t_pod":    ("task", "Зібрати POD, статус «Delivered»", 630, 290, "lane_sys"),
    "e_end_ok": ("end", "Доставку підтверджено", 750, 290, "lane_sys"),
    "t_call":   ("task", "AI телефонує водієві та записує статус", 860, 450, "lane_ai"),
    "g_ans":    ("gw", "Водій відповів?", 970, 450, "lane_ai"),
    "t_parse":  ("task", "Розпізнати відповідь, записати локацію та ETA", 1100, 450, "lane_ai"),
    "g_exc":    ("gw", "Виявлено виняток?", 1220, 450, "lane_ai"),
    "t_sms":    ("task", "Надіслати SMS та email із запитом статусу", 1100, 570, "lane_ai"),
    "e_wait":   ("timer", "Очікування 15 хв", 1220, 570, "lane_ai"),
    "g_resp":   ("gw", "Отримано відповідь?", 1320, 570, "lane_ai"),
    "sp_exc":   ("sub", "Обробка винятку", 1500, 700, "lane_disp"),
    "be_timer": ("btimer", "Не вирішено за 60 хв", 1610, 675, "lane_disp"),
    "t_lead":   ("task", "Ескалація керівнику зміни", 1760, 675, "lane_disp"),
    "e_lead":   ("end", "Керівника зміни підключено", 1900, 675, "lane_disp"),
    "be_err":   ("berr", "Рейс неможливо продовжити", 1420, 750, "lane_disp"),
    "e_end_x":  ("end", "Рейс закрито з винятком", 1260, 800, "lane_disp"),
}
MAIN_E = [
    ("e_start", "t_plan", [(219, 120), (280, 120)], ""),
    ("t_plan", "e_timer", [(440, 120), (461, 120)], ""),
    ("e_timer", "t_pos", [(499, 120), (530, 120)], ""),
    ("t_pos", "g_fresh", [(690, 120), (719, 120)], ""),
    ("g_fresh", "g_dev", [(771, 120), (834, 120)], "так"),
    ("g_dev", "t_upd", [(886, 120), (1320, 120)], "ні — у графіку"),
    ("g_fresh", "t_call", [(745, 146), (745, 450), (780, 450)], "ні — тиша > 30 хв", (886, 246)),
    ("t_call", "g_ans", [(940, 450), (944, 450)], ""),
    ("g_ans", "t_parse", [(996, 450), (1020, 450)], "так"),
    ("t_parse", "g_exc", [(1180, 450), (1194, 450)], ""),
    ("g_exc", "t_upd", [(1246, 450), (1280, 450), (1280, 120), (1320, 120)], "ні"),
    ("g_ans", "t_sms", [(970, 476), (970, 570), (1020, 570)], "ні", (986, 522)),
    ("t_sms", "e_wait", [(1180, 570), (1201, 570)], ""),
    ("e_wait", "g_resp", [(1239, 570), (1294, 570)], ""),
    ("g_resp", "t_parse", [(1320, 544), (1320, 510), (1100, 510), (1100, 487)], "так", (1247, 500)),
    ("g_exc", "sp_exc", [(1220, 476), (1220, 690), (1390, 690)], "так — виняток", (1247, 662)),
    ("g_resp", "sp_exc", [(1346, 570), (1372, 570), (1372, 725), (1390, 725)], "ні — 2 спроби", (1334, 648)),
    ("sp_exc", "e_timer", [(1610, 730), (1666, 730), (1666, 858), (480, 858), (480, 139)],
     "виняток вирішено — повернення в моніторинг", (1000, 846)),
    ("be_timer", "t_lead", [(1629, 675), (1680, 675)], ""),
    ("t_lead", "e_lead", [(1840, 675), (1881, 675)], ""),
    ("be_err", "e_end_x", [(1420, 769), (1420, 800), (1279, 800)], ""),
    ("e_geo", "t_geo", [(219, 232), (280, 232)], ""),
    ("t_geo", "g_dlv", [(440, 232), (454, 232)], ""),
    ("g_dlv", "e_timer", [(480, 206), (480, 139)], "ні", (500, 174)),
    ("g_dlv", "t_pod", [(506, 232), (525, 232), (525, 290), (550, 290)], "так"),
    ("t_pod", "e_end_ok", [(710, 290), (731, 290)], ""),
]
MAIN_LBL_POS = {"e_timer": (480, 64), "e_wait": (1220, 614), "e_end_x": (1260, 839),
                "be_timer": (1665, 620), "be_err": (1540, 800), "g_dev": (905, 68)}

# ---------------------------------------------------------------- підпроцес
ROWS = {"a": 160, "b": 275, "c": 390, "d": 505, "e": 620, "f": 735, "g": 850}
TYPES = {
    "a": "Пропущене вікно pickup або delivery",
    "b": "Втрата трекінгу, водій недоступний",
    "c": "Поломка, ДТП, потреба в recovery",
    "d": "Затримка в дорозі: HOS, трафік, погода",
    "e": "Detention, простій, lumper",
    "f": "Розбіжність документів, OS&D",
    "g": "Комплаєнс перевізника",
}
SUB = {
    "s_start": ("start", "Виняток зареєстровано", 130, 505, "sub"),
    "s_class": ("task", "Класифікувати виняток за типом, джерелом і впливом на SLA", 290, 505, "sub"),
    "s_gw":    ("gw", "Тип винятку?", 440, 505, "sub"),
    "a1": ("task", "Перепризначити appointment зі складом або отримувачем", 590, ROWS["a"], "sub"),
    "a2": ("task", "Оновити вікно доставки та ETA у TMS", 800, ROWS["a"], "sub"),
    "b1": ("task", "Дзвінок перевізнику для відновлення зв'язку", 590, ROWS["b"], "sub"),
    "b2": ("task", "Пошук заміни або процедура lost load", 800, ROWS["b"], "sub"),
    "c1": ("task", "Залучити roadside assistance, оцінити стан вантажу", 590, ROWS["c"], "sub"),
    "c2": ("task", "Організувати recovery truck і перевантаження", 800, ROWS["c"], "sub"),
    "d1": ("task", "Перерахувати ETA з урахуванням HOS і трафіку", 590, ROWS["d"], "sub"),
    "d2": ("task", "Проактивно повідомити клієнта про затримку", 800, ROWS["d"], "sub"),
    "e1": ("task", "Запустити таймери detention і простою", 590, ROWS["e"], "sub"),
    "e2": ("task", "Погодити accessorial charge із клієнтом", 800, ROWS["e"], "sub"),
    "f1": ("task", "Запросити фото BOL, POD і опис розбіжності", 590, ROWS["f"], "sub"),
    "f2": ("task", "Відкрити OS&D claim, повідомити страховика", 800, ROWS["f"], "sub"),
    "g1": ("task", "Заблокувати вантаж, вимагати ліцензію та страховку", 590, ROWS["g"], "sub"),
    "g2": ("task", "Перевірити ознаки double-brokering у профілі", 800, ROWS["g"], "sub"),
    "s_merge": ("gw", "", 960, 505, "sub"),
    "s_log":  ("task", "Задокументувати причину, тег винятку й рішення в TMS", 1080, 505, "sub"),
    "s_sla":  ("gw", "Ризик SLA?", 1240, 505, "sub"),
    "s_comp": ("task", "Узгодити компенсацію та новий SLA із клієнтом", 1400, 390, "sub"),
    "s_merge2": ("gw", "", 1560, 505, "sub"),
    "s_cont": ("gw", "Рейс можна продовжити?", 1660, 505, "sub"),
    "s_end_ok": ("end", "Виняток закрито, моніторинг триває", 1790, 430, "sub"),
    "s_end_err": ("errend", "Рейс неможливо продовжити", 1790, 600, "sub"),
}
SUB_E = [("s_start", "s_class", [(149, 505), (210, 505)], ""),
         ("s_class", "s_gw", [(370, 505), (414, 505)], "")]
for k, cy in ROWS.items():
    anchor = (590, cy - 52)
    if k == "d":
        SUB_E.append(("s_gw", "d1", [(466, 505), (510, 505)], TYPES[k], anchor))
        SUB_E.append(("d2", "s_merge", [(880, 505), (934, 505)], ""))
    else:
        y0 = 479 if cy < 505 else 531
        y1 = 479 if cy < 505 else 531
        SUB_E.append(("s_gw", k + "1", [(440, y0), (440, cy), (510, cy)], TYPES[k], anchor))
        SUB_E.append((k + "2", "s_merge", [(880, cy), (960, cy), (960, y1)], ""))
    SUB_E.append((k + "1", k + "2", [(670, cy), (720, cy)], ""))
SUB_E += [
    ("s_merge", "s_log", [(986, 505), (1000, 505)], ""),
    ("s_log", "s_sla", [(1160, 505), (1214, 505)], ""),
    ("s_sla", "s_comp", [(1240, 479), (1240, 390), (1320, 390)], "так", (1303, 470)),
    ("s_comp", "s_merge2", [(1480, 390), (1560, 390), (1560, 479)], ""),
    ("s_sla", "s_merge2", [(1266, 505), (1534, 505)], "ні"),
    ("s_merge2", "s_cont", [(1586, 505), (1634, 505)], ""),
    ("s_cont", "s_end_ok", [(1660, 479), (1660, 430), (1771, 430)], "так", (1722, 416)),
    ("s_cont", "s_end_err", [(1660, 531), (1660, 600), (1771, 600)], "ні", (1722, 586)),
]
SUB_LBL_POS = {"s_end_ok": (1790, 391), "s_end_err": (1790, 561),
               "s_sla": (1240, 570), "s_cont": (1626, 452)}

# Ці два блоки (чорні скриньки й message flows) більше НЕ малюються на
# ілюстративному SVG підпроцесу (модель це прибрала - див. checkcall-
# exception.bpmn, де message flows належать за BPMN-семантикою: у
# collaboration-діаграмі, а не домальовані поверх process-діаграми).
# Дані MF лишаються тут і йдуть тільки в checkcall-exception.bpmn.
FRAME_Y, FRAME_H = 70, 890

MF = [
    ("a1", "p_carrier", "Новий слот appointment"),
    ("b1", "p_carrier", "Запис зв'язку з водієм"),
    ("c1", "p_carrier", "Наряд roadside і recovery"),
    ("f1", "p_carrier", "Запит фото BOL і POD"),
    ("g1", "p_carrier", "Запит ліцензії та страховки"),
    ("p_carrier", "f1", "Фото BOL, POD, коментар водія"),
    ("a2", "p_client", "Нове вікно доставки та ETA"),
    ("d2", "p_client", "Повідомлення про затримку"),
    ("e2", "p_client", "Погодження accessorial"),
    ("f2", "p_client", "Повідомлення про OS&D claim"),
    ("s_comp", "p_client", "Пропозиція компенсації та SLA"),
]


def size(t):
    return {"task": (W_T, H_T), "sub": (W_S, H_S), "gw": (S_G, S_G)}.get(t, (S_E, S_E))


def box(nodes, nid):
    t, _, cx, cy, _ = nodes[nid]
    w, h = size(t)
    return cx - w / 2, cy - h / 2, w, h


def wrap(label, width_px, s):
    return textwrap.wrap(label, max(8, int(width_px / (s * 0.52))))


def tblock(lines, cx, cy, s, color=INK, weight="500"):
    out, total = [], len(lines) * (s + 3) - 3
    y = cy - total / 2 + s * 0.82
    for ln in lines:
        out.append(f'<text x="{cx:.0f}" y="{y:.1f}" font-family="{FONT}" font-size="{s}" font-weight="{weight}" '
                   f'fill="{color}" text-anchor="middle">{html.escape(ln)}</text>')
        y += s + 3
    return "".join(out)


def draw_edges(edges, out):
    for _e in edges:
        a, b, wps, lbl = _e[0], _e[1], _e[2], _e[3]
        anchor = _e[4] if len(_e) > 4 else None
        out.append('<path d="M ' + " L ".join(f"{x} {y}" for x, y in wps) +
                   f'" fill="none" stroke="{INK}" stroke-width="1.5" marker-end="url(#arr)"/>')
        if not lbl:
            continue
        if anchor:
            lx, ly = anchor
        else:
            (x1, y1), (x2, y2) = wps[0], wps[1]
            if abs(y2 - y1) < abs(x2 - x1):
                lx, ly = (x1 + x2) / 2, min(y1, y2) - 10
            else:
                lx, ly = x1 + 10 + len(lbl) * 3.2, (y1 + y2) / 2
        lines = wrap(lbl, 170, 11)
        w = max(len(l) for l in lines) * 5.9 + 8
        h = len(lines) * 14 + 4
        out.append(f'<rect x="{lx-w/2:.0f}" y="{ly-h/2:.0f}" width="{w:.0f}" height="{h:.0f}" rx="3" fill="#ffffff" opacity="0.93"/>')
        out.append(tblock(lines, lx, ly, 11, SUB_INK, "600"))


def draw_nodes(nodes, out, lbl_pos):
    for nid, (t, label, cx, cy, lane) in nodes.items():
        x, y, w, h = box(nodes, nid)
        c, f = ACC[lane], FILL[lane]
        if t in ("task", "sub"):
            out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="{f}" stroke="{c}" stroke-width="{2.2 if t=="sub" else 1.8}"/>')
            out.append(tblock(wrap(label, w - 16, 12 if t == "sub" else 11.5), cx, cy - (10 if t == "sub" else 0),
                              12 if t == "sub" else 11.5, INK, "700" if t == "sub" else "500"))
            if t == "sub":
                out.append(f'<rect x="{cx-10}" y="{y+h-24}" width="20" height="20" fill="none" stroke="{c}" stroke-width="1.5"/>')
                out.append(f'<path d="M {cx-5} {y+h-14} L {cx+5} {y+h-14} M {cx} {y+h-19} L {cx} {y+h-9}" stroke="{c}" stroke-width="1.6"/>')
        elif t == "gw":
            out.append(f'<path d="M {cx} {y} L {x+w} {cy} L {cx} {y+h} L {x} {cy} Z" fill="#ffffff" stroke="{c}" stroke-width="1.8"/>')
            out.append(f'<path d="M {cx-9} {cy-9} L {cx+9} {cy+9} M {cx+9} {cy-9} L {cx-9} {cy+9}" stroke="{c}" stroke-width="2"/>')
            if label:
                gx, gy = lbl_pos.get(nid, (cx, cy - h / 2 - 22))
                gl = wrap(label, 150, 11)
                gw_ = max(len(l) for l in gl) * 5.9 + 10
                gh_ = len(gl) * 14 + 4
                out.append(f'<rect x="{gx-gw_/2:.0f}" y="{gy-gh_/2:.0f}" width="{gw_:.0f}" height="{gh_:.0f}" rx="3" fill="#ffffff" opacity="0.93"/>')
                out.append(tblock(gl, gx, gy, 11, SUB_INK, "600"))
        else:
            r = S_E / 2
            sw = 3.0 if t in ("end", "errend") else 1.8
            out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" stroke="{c}" stroke-width="{sw}"/>')
            if t in ("btimer", "berr"):
                out.append(f'<circle cx="{cx}" cy="{cy}" r="{r-4}" fill="#ffffff" stroke="{c}" stroke-width="1.5"'
                           + (' stroke-dasharray="4 3"' if t == "btimer" else "") + "/>")
                out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{c}" stroke-width="1.5"'
                           + (' stroke-dasharray="4 3"' if t == "btimer" else "") + "/>")
            if t in ("timer", "btimer"):
                out.append(f'<circle cx="{cx}" cy="{cy}" r="10" fill="none" stroke="{c}" stroke-width="1.2"/>')
                out.append(f'<path d="M {cx} {cy-7} L {cx} {cy} L {cx+5} {cy+4}" fill="none" stroke="{c}" stroke-width="1.5"/>')
            if t == "msgstart":
                out.append(f'<rect x="{cx-8}" y="{cy-6}" width="16" height="12" fill="none" stroke="{c}" stroke-width="1.4"/>')
                out.append(f'<path d="M {cx-8} {cy-6} L {cx} {cy+1} L {cx+8} {cy-6}" fill="none" stroke="{c}" stroke-width="1.4"/>')
            if t in ("berr", "errend"):
                out.append(f'<path d="M {cx-7} {cy+6} L {cx-2} {cy-6} L {cx+2} {cy+2} L {cx+7} {cy-6}" fill="none" stroke="{c}" stroke-width="1.9"/>')
            pos = cy + r + 20 if t in ("start", "msgstart", "end", "errend") else cy - r - 20
            cx_l = cx
            if nid in lbl_pos:
                cx_l, pos = lbl_pos[nid]
            out.append(tblock(wrap(label, 150, 11), cx_l, pos, 11, INK, "600"))


LEGEND = [("Подія", "circle"), ("Таймер", "timer"), ("Задача", "rect"), ("XOR-шлюз", "diamond"),
          ("Підпроцес", "sub"), ("Гранична подія", "boundary"), ("Помилка", "error"), ("Message flow", "mflow")]

MF_INK = "#0f6fbf"


def draw_legend(out, lx, ly, width, note):
    out.append(f'<rect x="{lx}" y="{ly-22}" width="{width}" height="44" rx="6" fill="#f7f9fb" stroke="#d5dee6"/>')
    x = lx + 20
    for name, kind in LEGEND:
        if kind in ("circle", "timer", "msg", "boundary", "error"):
            out.append(f'<circle cx="{x+9}" cy="{ly}" r="9" fill="#fff" stroke="{INK}" stroke-width="1.6"/>')
            if kind == "timer":
                out.append(f'<path d="M {x+9} {ly-5} L {x+9} {ly} L {x+13} {ly+3}" fill="none" stroke="{INK}" stroke-width="1.4"/>')
            if kind == "msg":
                out.append(f'<rect x="{x+3}" y="{ly-4}" width="12" height="8" fill="none" stroke="{INK}" stroke-width="1.2"/>')
            if kind == "boundary":
                out.append(f'<circle cx="{x+9}" cy="{ly}" r="5.5" fill="none" stroke="{INK}" stroke-width="1.3"/>')
            if kind == "error":
                out.append(f'<path d="M {x+4} {ly+4} L {x+7} {ly-4} L {x+10} {ly+1} L {x+14} {ly-4}" fill="none" stroke="{INK}" stroke-width="1.7"/>')
        elif kind == "rect":
            out.append(f'<rect x="{x}" y="{ly-9}" width="26" height="18" rx="4" fill="#fff" stroke="{INK}" stroke-width="1.6"/>')
        elif kind == "mflow":
            out.append(f'<path d="M {x} {ly} L {x+28} {ly}" stroke="{MF_INK}" stroke-width="1.5" stroke-dasharray="6 4"/>')
            out.append(f'<circle cx="{x+2}" cy="{ly}" r="2.6" fill="#fff" stroke="{MF_INK}" stroke-width="1.2"/>')
            out.append(f'<path d="M {x+22} {ly-4} L {x+28} {ly} L {x+22} {ly+4}" fill="none" stroke="{MF_INK}" stroke-width="1.4"/>')
        elif kind == "sub":
            out.append(f'<rect x="{x}" y="{ly-10}" width="28" height="20" rx="4" fill="#fff" stroke="{INK}" stroke-width="1.8"/>')
            out.append(f'<path d="M {x+11} {ly+5} L {x+17} {ly+5} M {x+14} {ly+2} L {x+14} {ly+8}" stroke="{INK}" stroke-width="1.4"/>')
        else:
            out.append(f'<path d="M {x+13} {ly-10} L {x+26} {ly} L {x+13} {ly+10} L {x} {ly} Z" fill="#fff" stroke="{INK}" stroke-width="1.6"/>')
        out.append(f'<text x="{x+36}" y="{ly+4}" font-family="{FONT}" font-size="12" fill="{INK}">{html.escape(name)}</text>')
        x += 36 + len(name) * 7.4 + 30
    out.append(f'<text x="{x+10}" y="{ly+4}" font-family="{FONT}" font-size="11.5" fill="#5b6f83">{html.escape(note)}</text>')


SRC = "Джерела логіки: FleetWorks, GoFast Freight, Descartes MacroPoint OpsForce, Tai TMS, Vektor TMS"

# ---------------------------------------------------------------- SVG 1: основний процес
o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="2070" height="960" viewBox="0 0 2070 960" font-family="{FONT}">',
     '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
     f'<path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker></defs>',
     '<rect width="100%" height="100%" fill="#ffffff"/>',
     tblock(["Автоматизований check-call: основний процес track & trace"], 1035, 30, 20, INK, "700")]
o.append(f'<rect x="{POOL_X}" y="{POOL_Y}" width="{POOL_W}" height="{POOL_H}" fill="none" stroke="{INK}" stroke-width="1.6"/>')
o.append(f'<rect x="{POOL_X}" y="{POOL_Y}" width="{LANE_HDR}" height="{POOL_H}" fill="#f4f6f8" stroke="{INK}" stroke-width="1.6"/>')
o.append(f'<text x="{POOL_X+22}" y="{POOL_Y+POOL_H/2}" font-size="13" font-weight="700" fill="{INK}" text-anchor="middle" '
         f'transform="rotate(-90 {POOL_X+22} {POOL_Y+POOL_H/2})">Брокер / логістична платформа</text>')
for lid, lname, ly_, lh in LANES:
    o.append(f'<rect x="{POOL_X+LANE_HDR}" y="{ly_}" width="{POOL_W-LANE_HDR}" height="{lh}" fill="none" stroke="{INK}" stroke-width="1"/>')
    o.append(f'<rect x="{POOL_X+LANE_HDR}" y="{ly_}" width="{LANE_HDR}" height="{lh}" fill="{FILL[lid]}" stroke="{INK}" stroke-width="1"/>')
    cyl, xl = ly_ + lh / 2, POOL_X + LANE_HDR + 22
    o.append(f'<text x="{xl}" y="{cyl}" font-size="12.5" font-weight="700" fill="{ACC[lid]}" text-anchor="middle" '
             f'transform="rotate(-90 {xl} {cyl})">{html.escape(lname)}</text>')
draw_edges(MAIN_E, o)
draw_nodes(MAIN, o, MAIN_LBL_POS)
draw_legend(o, 60, 910, 1900, SRC)
o.append("</svg>")
open("checkcall-bpmn.svg", "w", encoding="utf-8").write("\n".join(o))

# ---------------------------------------------------------------- SVG 2: підпроцес
o2 = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1960" height="1030" viewBox="0 0 1960 1030" font-family="{FONT}">',
      '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
      f'<path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker></defs>',
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      tblock(["Підпроцес «Обробка винятку»: типи винятків і сценарії вирішення"], 980, 30, 20, INK, "700")]
o2.append(f'<rect x="40" y="{FRAME_Y}" width="1880" height="{FRAME_H}" rx="14" fill="none" stroke="{ACC["sub"]}" stroke-width="2.2"/>')
o2.append(f'<text x="60" y="{FRAME_Y+24}" font-family="{FONT}" font-size="12.5" font-weight="700" fill="{ACC["sub"]}">'
          'Обробка винятку (розгорнутий підпроцес)</text>')
draw_edges(SUB_E, o2)
draw_nodes(SUB, o2, SUB_LBL_POS)
draw_legend(o2, 40, 1000, 1880, SRC)
o2.append("</svg>")
open("checkcall-exception-subprocess.svg", "w", encoding="utf-8").write("\n".join(o2))

print("main nodes", len(MAIN), "| sub nodes", len(SUB))

# ==================================================================
# BPMN 2.0 XML
# ==================================================================
TAG = {"start": "startEvent", "msgstart": "startEvent", "end": "endEvent", "errend": "endEvent",
       "timer": "intermediateCatchEvent", "gw": "exclusiveGateway", "task": "task",
       "sub": "subProcess", "btimer": "boundaryEvent", "berr": "boundaryEvent"}
ALL = dict(MAIN)
ALL.update(SUB)
SUB_IDS = set(SUB)

flows = []
inc = {n: [] for n in ALL}
outg = {n: [] for n in ALL}
for i, _e in enumerate(MAIN_E + SUB_E, 1):
    fid = f"flow_{i}"
    flows.append((fid, _e[0], _e[1], _e[2], _e[3]))
    outg[_e[0]].append(fid)
    inc[_e[1]].append(fid)


def node_xml(nid, indent):
    t, label, cx, cy, lane = ALL[nid]
    tag, p = TAG[t], " " * indent
    attrs = f'id="{nid}" name="{html.escape(label)}"'
    if t in ("btimer", "berr"):
        attrs += ' attachedToRef="sp_exc"' + (' cancelActivity="false"' if t == "btimer" else "")
    body = "".join(f'\n{p}  <bpmn:incoming>{f}</bpmn:incoming>' for f in inc[nid])
    body += "".join(f'\n{p}  <bpmn:outgoing>{f}</bpmn:outgoing>' for f in outg[nid])
    if t in ("timer", "btimer"):
        body += f'\n{p}  <bpmn:timerEventDefinition id="td_{nid}"/>'
    if t == "msgstart":
        body += f'\n{p}  <bpmn:messageEventDefinition id="md_{nid}"/>'
    if t in ("berr", "errend"):
        body += f'\n{p}  <bpmn:errorEventDefinition id="ed_{nid}"/>'
    if t == "sub":
        body += '\n' + "\n".join(node_xml(k, indent + 2) for k in SUB)
        body += '\n' + "\n".join(
            f'{p}  <bpmn:sequenceFlow id="{f}"' + (f' name="{html.escape(l)}"' if l else "") +
            f' sourceRef="{a}" targetRef="{b}"/>'
            for f, a, b, w, l in flows if a in SUB_IDS and b in SUB_IDS)
    return f'{p}<bpmn:{tag} {attrs}>{body}\n{p}</bpmn:{tag}>'


x = ['<?xml version="1.0" encoding="UTF-8"?>',
     '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
     'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
     'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="defs_checkcall" targetNamespace="http://logistics/checkcall">',
     '  <bpmn:process id="proc_checkcall" name="Автоматизований check-call" isExecutable="false">',
     '    <bpmn:laneSet id="laneset_1">']
for lid, lname, ly_, lh in LANES:
    refs = "".join(f'\n        <bpmn:flowNodeRef>{n}</bpmn:flowNodeRef>' for n, v in MAIN.items() if v[4] == lid)
    x.append(f'      <bpmn:lane id="{lid}" name="{html.escape(lname)}">{refs}\n      </bpmn:lane>')
x.append('    </bpmn:laneSet>')
for nid in MAIN:
    x.append(node_xml(nid, 4))
for f, a, b, w, l in flows:
    if a in SUB_IDS and b in SUB_IDS:
        continue
    nm = f' name="{html.escape(l)}"' if l else ""
    x.append(f'    <bpmn:sequenceFlow id="{f}"{nm} sourceRef="{a}" targetRef="{b}"/>')
x.append('  </bpmn:process>')
x.append('  <bpmndi:BPMNDiagram id="diag_1">')
x.append('    <bpmndi:BPMNPlane id="plane_main" bpmnElement="proc_checkcall">')
for lid, lname, ly_, lh in LANES:
    x.append(f'      <bpmndi:BPMNShape id="{lid}_di" bpmnElement="{lid}" isHorizontal="true">'
             f'<dc:Bounds x="{POOL_X+LANE_HDR}" y="{ly_}" width="{POOL_W-LANE_HDR}" height="{lh}"/></bpmndi:BPMNShape>')
for nid in MAIN:
    bx, by, bw, bh = box(MAIN, nid)
    x.append(f'      <bpmndi:BPMNShape id="{nid}_di" bpmnElement="{nid}">'
             f'<dc:Bounds x="{bx:.0f}" y="{by:.0f}" width="{bw:.0f}" height="{bh:.0f}"/></bpmndi:BPMNShape>')
for f, a, b, w, l in flows:
    if a in SUB_IDS and b in SUB_IDS:
        continue
    pts = "".join(f'<di:waypoint x="{px:.0f}" y="{py:.0f}"/>' for px, py in w)
    x.append(f'      <bpmndi:BPMNEdge id="{f}_di" bpmnElement="{f}">{pts}</bpmndi:BPMNEdge>')
x.append('    </bpmndi:BPMNPlane>')
x.append('    <bpmndi:BPMNPlane id="plane_sub" bpmnElement="sp_exc">')
for nid in SUB:
    bx, by, bw, bh = box(SUB, nid)
    x.append(f'      <bpmndi:BPMNShape id="{nid}_di" bpmnElement="{nid}">'
             f'<dc:Bounds x="{bx:.0f}" y="{by:.0f}" width="{bw:.0f}" height="{bh:.0f}"/></bpmndi:BPMNShape>')
for f, a, b, w, l in flows:
    if a in SUB_IDS and b in SUB_IDS:
        pts = "".join(f'<di:waypoint x="{px:.0f}" y="{py:.0f}"/>' for px, py in w)
        x.append(f'      <bpmndi:BPMNEdge id="{f}_di" bpmnElement="{f}">{pts}</bpmndi:BPMNEdge>')
x.append('    </bpmndi:BPMNPlane>')
x.append('  </bpmndi:BPMNDiagram>')
x.append('</bpmn:definitions>')
open("checkcall.bpmn", "w", encoding="utf-8").write("\n".join(x))

# ---- checkcall-exception.bpmn: колаборація підпроцесу з message flows ----
xc = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="defs_exception" targetNamespace="http://logistics/checkcall">',
      '  <bpmn:collaboration id="collab_exception">',
      '    <bpmn:participant id="p_broker" name="Диспетчерська: обробка винятку" processRef="proc_exception"/>',
      '    <bpmn:participant id="p_carrier" name="Перевізник, водій, склад"/>',
      '    <bpmn:participant id="p_client" name="Клієнт (вантажовідправник)"/>']
MF_IDS = []
for i, (a, b, lbl) in enumerate(MF, 1):
    mid = f"mflow_{i}"
    MF_IDS.append((mid, a, b))
    xc.append(f'    <bpmn:messageFlow id="{mid}" name="{html.escape(lbl)}" sourceRef="{a}" targetRef="{b}"/>')
xc.append('  </bpmn:collaboration>')
xc.append('  <bpmn:process id="proc_exception" name="Обробка винятку" isExecutable="false">')
for nid in SUB:
    xc.append(node_xml(nid, 4))
for f, a, b, w, l in flows:
    if a in SUB_IDS and b in SUB_IDS:
        nm = f' name="{html.escape(l)}"' if l else ""
        xc.append(f'    <bpmn:sequenceFlow id="{f}"{nm} sourceRef="{a}" targetRef="{b}"/>')
xc.append('  </bpmn:process>')
xc.append('  <bpmndi:BPMNDiagram id="diag_exc">')
xc.append('    <bpmndi:BPMNPlane id="plane_collab" bpmnElement="collab_exception">')
xc.append(f'      <bpmndi:BPMNShape id="p_broker_di" bpmnElement="p_broker" isHorizontal="true">'
          f'<dc:Bounds x="40" y="{FRAME_Y}" width="1880" height="{FRAME_H}"/></bpmndi:BPMNShape>')
xc.append('      <bpmndi:BPMNShape id="p_carrier_di" bpmnElement="p_carrier" isHorizontal="true">'
          '<dc:Bounds x="40" y="1000" width="1880" height="80"/></bpmndi:BPMNShape>')
xc.append('      <bpmndi:BPMNShape id="p_client_di" bpmnElement="p_client" isHorizontal="true">'
          '<dc:Bounds x="40" y="1120" width="1880" height="80"/></bpmndi:BPMNShape>')
for nid in SUB:
    bx, by, bw, bh = box(SUB, nid)
    xc.append(f'      <bpmndi:BPMNShape id="{nid}_dic" bpmnElement="{nid}">'
              f'<dc:Bounds x="{bx:.0f}" y="{by:.0f}" width="{bw:.0f}" height="{bh:.0f}"/></bpmndi:BPMNShape>')
for f, a, b, w, l in flows:
    if a in SUB_IDS and b in SUB_IDS:
        pts = "".join(f'<di:waypoint x="{px:.0f}" y="{py:.0f}"/>' for px, py in w)
        xc.append(f'      <bpmndi:BPMNEdge id="{f}_dic" bpmnElement="{f}">{pts}</bpmndi:BPMNEdge>')
for mid, a, b in MF_IDS:
    ax, ay, aw, ah = box(SUB, a) if a in SUB else (0, 1040, 0, 0)
    bx_, by_, bw_, bh_ = box(SUB, b) if b in SUB else (0, 1040, 0, 0)
    x1 = ax + aw / 2 if a in SUB else ax
    y1 = ay + ah if a in SUB else 1040
    x2 = bx_ + bw_ / 2 if b in SUB else bx_
    y2 = by_ if b in SUB else 1040
    xc.append(f'      <bpmndi:BPMNEdge id="{mid}_di" bpmnElement="{mid}">'
              f'<di:waypoint x="{x1:.0f}" y="{y1:.0f}"/><di:waypoint x="{x2:.0f}" y="{y2:.0f}"/></bpmndi:BPMNEdge>')
xc.append('    </bpmndi:BPMNPlane>')
xc.append('  </bpmndi:BPMNDiagram>')
xc.append('</bpmn:definitions>')
open("checkcall-exception.bpmn", "w", encoding="utf-8").write("\n".join(xc))
print("message flows", len(MF_IDS))
