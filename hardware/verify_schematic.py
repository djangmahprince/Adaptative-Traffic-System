"""Cross-checks traffic_system.kicad_sch against BOM.csv: every reference
designator in the BOM that should appear on the schematic (i.e. not
breadboards/wires/mechanical items) must appear exactly once, and vice versa.
"""
import csv
import re

with open("traffic_system.kicad_sch", encoding="utf-8") as f:
    full_sch = f.read()


def strip_balanced_block(text, start_token):
    """Removes the first `(start_token ...)` block (with balanced parens),
    e.g. lib_symbols, so its generic template Reference/uuid values (which
    are expected to look like duplicates/placeholders) don't get checked
    against the real per-instance properties that follow it."""
    start = text.index(f"({start_token}")
    depth = 0
    i = start
    while True:
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return text[:start] + text[i + 1:]


sch = strip_balanced_block(full_sch, "lib_symbols")

refs_in_sch = re.findall(r'\(property\s+"Reference"\s+"([^"]+)"', sch, re.DOTALL)
dupes = {r for r in refs_in_sch if refs_in_sch.count(r) > 1}
assert not dupes, f"Duplicate reference designators in schematic: {dupes}"

with open("BOM.csv", encoding="utf-8") as f:
    bom_refs = [row["RefDes"] for row in csv.DictReader(f)]

# Non-electrical BOM lines that intentionally don't appear on the schematic.
NOT_ON_SCHEMATIC = {"BB1", "BB2", "W1", "CBL1", "PWR1", "BASE1", "VEH1", "TAG1", "TAG2"}
expected = [r for r in bom_refs if r not in NOT_ON_SCHEMATIC]

missing_from_sch = sorted(set(expected) - set(refs_in_sch))
extra_in_sch = sorted(set(refs_in_sch) - set(expected))

print(f"BOM electrical parts expected on schematic: {len(expected)}")
print(f"References found on schematic: {len(refs_in_sch)}")
print(f"Missing from schematic: {missing_from_sch}")
print(f"Extra/unexpected on schematic: {extra_in_sch}")

assert not missing_from_sch, "BOM parts missing from schematic!"
assert not extra_in_sch, "Schematic has parts not in BOM!"

labels = re.findall(r'\(label\s+"([^"]+)"', sch, re.DOTALL)
from collections import Counter
counts = Counter(labels)
print(f"\nTotal net label instances: {len(labels)}")
print(f"Unique net names: {len(counts)}")
singletons = [n for n, c in counts.items() if c == 1]
print(f"Net names appearing only once (dead-end / unconnected net — expect none): {singletons}")
assert not singletons, "Found a net label that only appears once — that pin is not actually connected to anything!"

print("\nALL CHECKS PASSED")
