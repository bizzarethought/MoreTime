"""Render the fictional attachment and its thumbnail from one source record."""
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
data = json.loads((root / "sample-bill.json").read_text())
assert data["fictional"] is True
assets = root / "dist" / "assets"
assets.mkdir(parents=True, exist_ok=True)
rows = [
    ("Account", data["account"]),
    ("Service", f'{data["service"]} / {data["state"]}'),
    ("Billing period", data["billing_period"]),
    ("Bill issued", data["issue_date"]),
    ("Payment due", data["due_date"]),
    ("Current charges", f'${data["current_amount"]:.2f}'),
    ("Previous bill", f'${data["previous_amount"]:.2f}'),
    ("Meter reading", data["meter_reading_type"]),
]

# A small, standards-based PDF using built-in Helvetica fonts; no dependencies.
commands = ["0.97 0.98 1 rg 0 0 595 842 re f", "1 1 1 rg 30 30 535 782 re f"]
def pdf_text(x, y, text, size=12, bold=False, color="0.13 0.16 0.21"):
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    font = "F2" if bold else "F1"
    commands.append(f"{color} rg BT /{font} {size} Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET")

pdf_text(55, 770, "FICTIONAL SAMPLE - NOT PAYABLE", 10, True, "0.63 0.31 0.08")
pdf_text(55, 720, data["provider"], 27, True, "0.10 0.30 0.70")
pdf_text(55, 693, "Monthly electricity bill", 14)
pdf_text(55, 627, f'${data["current_amount"]:.2f}', 38, True)
pdf_text(55, 600, f'Due {data["due_date"]}', 13)
for index, (label, value) in enumerate(rows):
    y = 546 - index * 39
    pdf_text(55, y, label, 11, color="0.40 0.43 0.49")
    pdf_text(205, y, value, 11, True)
    commands.append(f"0.88 0.91 0.95 RG 0.5 w 55 {y - 12} m 540 {y - 12} l S")
pdf_text(55, 160, "Created for the MoreTime interactive preview.", 11)
pdf_text(55, 140, "Provider, account, and charges are fictional.", 11)
pdf_text(55, 120, "No payment is due. This is not a real utility document.", 11)
stream = "\n".join(commands).encode("ascii")
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(assets / "example-utility-bill.pdf").write_bytes(pdf)

# The thumbnail uses the same values as the PDF and is readable at full size.
svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842">',
       '<rect width="595" height="842" fill="#fff"/>',
       '<g font-family="Arial, sans-serif">']
def svg_text(x, y, text, size=12, color="#283442", bold=False):
    weight = ' font-weight="700"' if bold else ''
    svg.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}"{weight}>{html.escape(text)}</text>')
svg_text(45, 55, "FICTIONAL SAMPLE - NOT PAYABLE", 13, "#a04f15", True)
svg_text(45, 115, data["provider"], 32, "#1959e8", True)
svg_text(45, 145, "Monthly electricity bill", 17)
svg_text(45, 220, f'${data["current_amount"]:.2f}', 42, bold=True)
svg_text(45, 250, f'Due {data["due_date"]}', 16)
for index, (label, value) in enumerate(rows):
    y = 310 + index * 42
    svg_text(45, y, label, 13, "#68727e")
    svg_text(195, y, value, 13, bold=True)
    svg.append(f'<path d="M45 {y+15}H550" stroke="#e1e6ee"/>')
svg_text(45, 720, "Created for the MoreTime interactive preview.", 13)
svg_text(45, 746, "Provider, account, and charges are fictional.", 13)
svg_text(45, 772, "No payment is due.", 13)
svg.append('</g></svg>')
(assets / "example-utility-bill.svg").write_text("\n".join(svg))
print("Generated fictional PDF attachment and matching thumbnail.")
