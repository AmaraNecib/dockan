import sys


def resolve_ours(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    out = []
    i = 0
    blocks = 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<<"):
            blocks += 1
            i += 1
            ours = []
            while not (lines[i].startswith("=======") or lines[i].startswith("|||||||")):
                ours.append(lines[i])
                i += 1
            if lines[i].startswith("|||||||"):
                while not lines[i].startswith("======="):
                    i += 1
            i += 1  # skip =======
            while not lines[i].startswith(">>>>>>>"):
                i += 1
            i += 1  # skip >>>>>>>
            out.extend(ours)
        else:
            out.append(lines[i])
            i += 1
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
    print(f"{path}: {blocks} conflict block(s) -> ours")


for p in sys.argv[1:]:
    resolve_ours(p)
