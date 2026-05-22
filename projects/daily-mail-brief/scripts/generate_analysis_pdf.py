import sys
import os
import re
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import mm

NAVY = colors.HexColor('#1a3a5c')
ATTENTION_RED = colors.HexColor('#c0392b')
ROW_LIGHT = colors.HexColor('#f0f4f8')
ROW_WHITE = colors.white
SEPARATOR = colors.HexColor('#cccccc')
TEXT_DARK = colors.HexColor('#222222')
TEXT_GREY = colors.HexColor('#666666')

# A4 usable width with 20mm margins each side
CONTENT_WIDTH = A4[0] - 40 * mm


def parse_section(md_content, section_title, icon_char):
    escaped_title = re.escape(section_title)
    section_pattern = re.escape(icon_char) + r" \*" + escaped_title + r" \(\d+\)\*"
    match = re.search(section_pattern + r"(.*?)(?=\n[☀📌📊📩]|\Z)", md_content, re.DOTALL)
    if not match:
        return []

    section_text = match.group(1).strip()
    item_pattern = r"• \*(.*?)\* — (.*?)\n(.*?)(?=\n• \*|\Z)"
    items = re.findall(item_pattern, section_text + "\n", re.DOTALL)
    return [(t.strip(), s.strip(), d.strip()) for t, s, d in items]


def clean_text(text):
    if not text:
        return ""
    text = text.replace('\u20b9', 'Rs.')
    cleaned = []
    for c in text:
        cp = ord(c)
        if cp > 0xFFFF or (0xFE00 <= cp <= 0xFE0F):
            continue
        cleaned.append(c)
    return "".join(cleaned)


def _get_styles():
    base = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'Title', parent=base['Heading1'],
        fontSize=22, spaceAfter=3, alignment=0,
        textColor=NAVY, fontName='Helvetica-Bold',
    )
    subtitle_style = ParagraphStyle(
        'Subtitle', parent=base['Normal'],
        fontSize=9, spaceAfter=2, textColor=TEXT_GREY,
    )
    section_style = ParagraphStyle(
        'Section', parent=base['Normal'],
        fontSize=10, spaceBefore=0, spaceAfter=0,
        textColor=colors.white, fontName='Helvetica-Bold',
        leftIndent=8, rightIndent=0,
        leading=22,
    )
    item_title_style = ParagraphStyle(
        'ItemTitle', parent=base['Normal'],
        fontSize=10, leading=14,
        fontName='Helvetica-Bold', textColor=TEXT_DARK,
        spaceAfter=3,
    )
    item_sender_style = ParagraphStyle(
        'ItemSender', parent=base['Normal'],
        fontSize=8, leading=11,
        fontName='Helvetica', textColor=TEXT_GREY,
        spaceAfter=0,
    )
    body_style = ParagraphStyle(
        'Body', parent=base['Normal'],
        fontSize=9, leading=13,
        textColor=TEXT_DARK, spaceAfter=0,
    )
    footer_style = ParagraphStyle(
        'Footer', parent=base['Normal'],
        fontSize=8, textColor=TEXT_GREY, alignment=1,
        fontName='Helvetica-Oblique',
    )
    return title_style, subtitle_style, section_style, item_title_style, item_sender_style, body_style, footer_style


def build_section_header(label, bg_color, section_style):
    """Render a colored section header bar."""
    header_table = Table(
        [[Paragraph(label, section_style)]],
        colWidths=[CONTENT_WIDTH],
    )
    header_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg_color),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    return header_table


def build_items_table(items, accent_color, item_title_style, body_style, item_sender_style):
    """One row per item, full-width, alternating backgrounds, colored left border."""
    data = []
    for title, sender, desc in items:
        ct = clean_text(title)
        cs = clean_text(sender)
        cd = clean_text(desc)
        # Each cell: title bold, sender grey below, then description
        cell_paras = [
            Paragraph(ct, item_title_style),
            Paragraph(f"— {cs}", item_sender_style),
            Spacer(1, 3),
            Paragraph(cd, body_style),
        ]
        data.append([cell_paras])

    if not data:
        return None

    table = Table(data, colWidths=[CONTENT_WIDTH])
    style_cmds = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('LINEABOVE', (0, 0), (-1, -1), 0.5, SEPARATOR),
        ('LINEBELOW', (0, -1), (-1, -1), 0.5, SEPARATOR),
        ('LINEBEFORE', (0, 0), (0, -1), 3, accent_color),
    ]
    for i in range(len(items)):
        bg = ROW_LIGHT if i % 2 == 0 else ROW_WHITE
        style_cmds.append(('BACKGROUND', (0, i), (0, i), bg))

    table.setStyle(TableStyle(style_cmds))
    return table


def create_pdf(needs_attention, worth_knowing, output_path, window_label):
    if not needs_attention and not worth_knowing:
        print("No items found to analyze.")
        return False

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
    )

    title_style, subtitle_style, section_style, item_title_style, item_sender_style, body_style, footer_style = _get_styles()

    elements = []

    # Header
    elements.append(Paragraph("Daily Briefing Analysis", title_style))
    elements.append(Paragraph(f"<b>Window:</b> {clean_text(window_label)}", subtitle_style))
    now_str = datetime.now().strftime("%d %b %Y | %I:%M %p IST")
    elements.append(Paragraph(f"<b>Generated:</b> {now_str}", subtitle_style))
    elements.append(Spacer(1, 5 * mm))
    elements.append(HRFlowable(width="100%", thickness=1.5, color=NAVY, spaceAfter=10))

    # Needs Attention
    if needs_attention:
        elements.append(build_section_header("  1.  NEEDS ATTENTION", ATTENTION_RED, section_style))
        elements.append(Spacer(1, 2 * mm))
        t = build_items_table(needs_attention, ATTENTION_RED, item_title_style, body_style, item_sender_style)
        if t:
            elements.append(t)
        elements.append(Spacer(1, 6 * mm))

    # Worth Knowing
    if worth_knowing:
        elements.append(build_section_header("  2.  WORTH KNOWING", NAVY, section_style))
        elements.append(Spacer(1, 2 * mm))
        t = build_items_table(worth_knowing, NAVY, item_title_style, body_style, item_sender_style)
        if t:
            elements.append(t)

    # Footer
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=SEPARATOR))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        "Automated analysis of your daily communications. For strategic decision-making and high-level scanning.",
        footer_style,
    ))

    doc.build(elements)
    print(f"Analysis PDF created: {output_path}")
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_analysis_pdf.py <briefing.md> [output.pdf]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "analysis_output.pdf"

    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found")
        sys.exit(1)

    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read()

    window_match = re.search(r"\*Mail Brief[^*]*?—\s*(.*?)\*", content)
    window_label = window_match.group(1).strip() if window_match else "Unknown Window"

    needs_attention = parse_section(content, "Needs Attention", "☀️")
    worth_knowing = parse_section(content, "Worth Knowing", "📌")

    print(f"Parsed {len(needs_attention)} Attention items, {len(worth_knowing)} Worth Knowing items.")

    if create_pdf(needs_attention, worth_knowing, output_path, window_label):
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
