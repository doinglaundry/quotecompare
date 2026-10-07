from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

folder = Path('artifacts/e2e-fixtures')
folder.mkdir(parents=True, exist_ok=True)
text = '12 King Street\nKitchen cabinets: 600\nWorktop: 300\nTotal GBP 1200\nVAT included\nWaste removal: Included\nPayment terms: 30% deposit\nDuration: 2 weeks\nMaterials: Laminate'
document = canvas.Canvas(str(folder / 'Contractor-A.pdf'))
for index, line in enumerate(text.splitlines()):
    document.drawString(40, 760 - index * 35, line)
document.save()
image = Image.new('RGB', (1600, 750), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 45)
for index, line in enumerate('Kitchen cabinets: 700\nAmount GBP 1100\nVAT included\nPayment terms: 20% deposit\nDuration: 3 weeks'.splitlines()):
    draw.text((40, 40 + index * 95), line, fill='black', font=font)
image.save(folder / 'Contractor-B.png')
(folder / 'Contractor-C.txt').write_text('Worktop: 350\nTotal GBP 1300\nWaste removal: Not included\nMaterials: Quartz', encoding='utf-8')
large_pdf = canvas.Canvas(str(folder / 'Too-many-pages.pdf'))
for index in range(31):
    large_pdf.drawString(40, 760, f'Page {index + 1}')
    large_pdf.showPage()
large_pdf.save()
(folder / 'Invalid.pdf').write_bytes(b'This is not a PDF')
from pypdf import PdfReader, PdfWriter
image.save(folder / 'Scanned.pdf', 'PDF', resolution=150)
image.save(folder / 'Contractor-B.jpg')
image.save(folder / 'Contractor-B.webp')
Image.new('RGB', (500, 500), 'white').save(folder / 'Blank.png')
encrypted = PdfWriter()
encrypted.append(PdfReader(folder / 'Contractor-A.pdf'))
encrypted.encrypt('test-password')
with (folder / 'Encrypted.pdf').open('wb') as stream:
    encrypted.write(stream)
