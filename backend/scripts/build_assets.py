#!/usr/bin/env python3
"""
Build the seeded document assets served by /api/files.

The demo dataset references real PDFs (previous-year question papers, the
official worksheet template, syllabi, e-library entries). Rather than shipping
opaque binaries of unknown provenance, this script *generates* them, so the
whole repository stays reviewable text and the download endpoints always hand
back a valid, openable PDF.

    python backend/scripts/build_assets.py
"""

from __future__ import annotations

import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "backend" / "assets" / "files"

PAGE_W, PAGE_H = 595, 842  # A4 in points


def escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


class Page:
    def __init__(self) -> None:
        self.ops: list[str] = []

    def text(self, x: float, y: float, value: str, size: int = 11,
             font: str = "F1", colour: str = "0.10 0.10 0.12") -> None:
        self.ops.append(
            f"BT /{font} {size} Tf {colour} rg 1 0 0 1 {x:.2f} {y:.2f} Tm ({escape(value)}) Tj ET"
        )

    def centred(self, y: float, value: str, size: int = 11,
                font: str = "F1", colour: str = "0.10 0.10 0.12") -> None:
        # Helvetica averages ~0.5 em per glyph; good enough for centring.
        width = len(value) * size * 0.5
        self.text((PAGE_W - width) / 2, y, value, size, font, colour)

    def right(self, y: float, value: str, size: int = 9,
              font: str = "F1", colour: str = "0.45 0.45 0.50") -> None:
        width = len(value) * size * 0.5
        self.text(PAGE_W - 60 - width, y, value, size, font, colour)

    def line(self, x1: float, y1: float, x2: float, y2: float,
             colour: str = "0.80 0.80 0.84", width: float = 0.7) -> None:
        self.ops.append(f"{colour} RG {width} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def rect(self, x: float, y: float, w: float, h: float,
             colour: str = "0.94 0.94 0.96", stroke: str | None = None) -> None:
        if stroke:
            self.ops.append(f"{colour} rg {stroke} RG 0.8 w {x:.2f} {y:.2f} {w:.2f} {h:.2f} re B")
        else:
            self.ops.append(f"{colour} rg {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def stream(self) -> bytes:
        return "\n".join(self.ops).encode("latin-1", "replace")


def build_pdf(pages: list[Page], title: str, author: str, subject: str) -> bytes:
    """Assemble a valid PDF 1.4 document with a correct cross-reference table."""
    objects: list[bytes] = []

    def add(payload: bytes) -> int:
        objects.append(payload)
        return len(objects)          # object numbers are 1-based

    font_regular = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                       b"/Encoding /WinAnsiEncoding >>")
    font_bold = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
                    b"/Encoding /WinAnsiEncoding >>")
    font_italic = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique "
                      b"/Encoding /WinAnsiEncoding >>")
    font_mono = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier "
                    b"/Encoding /WinAnsiEncoding >>")

    page_ids: list[int] = []
    content_ids: list[int] = []
    for page in pages:
        raw = page.stream()
        compressed = zlib.compress(raw, 9)
        content_ids.append(
            add(b"<< /Length " + str(len(compressed)).encode()
                + b" /Filter /FlateDecode >>\nstream\n" + compressed + b"\nendstream")
        )

    pages_id = len(objects) + 1
    objects.append(b"")           # placeholder for the /Pages node
    for content_id in content_ids:
        page_ids.append(
            add(b"<< /Type /Page /Parent " + str(pages_id).encode() + b" 0 R "
                b"/MediaBox [0 0 595 842] /Resources << /Font << /F1 "
                + str(font_regular).encode() + b" 0 R /F2 " + str(font_bold).encode()
                + b" 0 R /F3 " + str(font_italic).encode() + b" 0 R /F4 "
                + str(font_mono).encode() + b" 0 R >> >> /Contents "
                + str(content_id).encode() + b" 0 R >>")
        )

    objects[pages_id - 1] = (
        b"<< /Type /Pages /Count " + str(len(page_ids)).encode() + b" /Kids ["
        + b" ".join(str(pid).encode() + b" 0 R" for pid in page_ids) + b"] >>"
    )

    info_id = add(
        b"<< /Title (" + escape(title).encode("latin-1", "replace") + b")"
        b" /Author (" + escape(author).encode("latin-1", "replace") + b")"
        b" /Subject (" + escape(subject).encode("latin-1", "replace") + b")"
        b" /Creator (HPU Academic Portal asset generator)"
        b" /Producer (HPU Academic Portal asset generator) >>"
    )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, payload in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(index).encode() + b" 0 obj\n" + payload + b"\nendobj\n"

    xref_offset = len(out)
    count = len(objects) + 1
    out += b"xref\n0 " + str(count).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (b"trailer\n<< /Size " + str(count).encode() + b" /Root "
            + str(pages_id).encode() + b" 0 R /Info " + str(info_id).encode()
            + b" 0 R >>\nstartxref\n" + str(xref_offset).encode()
            + b"\n%%EOF\n")
    return bytes(out)


# ----------------------------------------------------------------------------
#  Document builders
# ----------------------------------------------------------------------------
MAROON = "0.42 0.09 0.20"


def cover(title: str, subtitle: str, institution: str, tag: str) -> Page:
    page = Page()
    page.rect(0, PAGE_H - 150, PAGE_W, 150, "0.42 0.09 0.20")
    page.text(60, PAGE_H - 62, "HIMACHAL PRADESH UNIVERSITY", 15, "F2", "1 1 1")
    page.text(60, PAGE_H - 86, "SHIMLA - 171001  |  HIMACHAL PRADESH, INDIA", 9, "F1", "0.92 0.88 0.86")
    page.text(60, PAGE_H - 116, institution, 10, "F3", "1 0.94 0.90")
    page.line(60, PAGE_H - 132, PAGE_W - 60, PAGE_H - 132, "0.95 0.90 0.86", 1.0)

    page.text(60, 660, tag, 9, "F2", MAROON)
    wrapped = wrap(title, 34)
    y = 620
    for line in wrapped:
        page.text(60, y, line, 22, "F2", "0.10 0.10 0.12")
        y -= 28

    page.line(60, y - 6, 200, y - 6, MAROON, 2.0)
    y -= 40
    for line in wrap(subtitle, 76):
        page.text(60, y, line, 11, "F1", "0.32 0.32 0.36")
        y -= 17

    page.rect(60, 92, PAGE_W - 120, 74, "0.96 0.96 0.97", "0.87 0.87 0.90")
    page.text(76, 140, "GENERATED DOCUMENT", 8, "F2", MAROON)
    page.text(76, 122, "Produced by backend/scripts/build_assets.py for the", 9, "F1", "0.35 0.35 0.40")
    page.text(76, 108, "HPU Academic Portal demonstration dataset.", 9, "F1", "0.35 0.35 0.40")
    return page


def content_page(heading: str, sections: list[tuple[str, list[str]]],
                 footer: str, page_no: int) -> Page:
    page = Page()
    page.rect(0, PAGE_H - 74, PAGE_W, 74, "0.42 0.09 0.20")
    page.text(60, PAGE_H - 44, "HPU ACADEMIC PORTAL", 11, "F2", "1 1 1")
    page.text(60, PAGE_H - 60, footer, 8, "F1", "0.92 0.88 0.86")
    page.line(60, PAGE_H - 74, PAGE_W - 60, PAGE_H - 74, "0.42 0.09 0.20", 1.5)

    page.text(60, PAGE_H - 108, heading, 16, "F2", "0.10 0.10 0.12")
    page.line(60, PAGE_H - 120, PAGE_W - 60, PAGE_H - 120, "0.87 0.87 0.90")

    y = PAGE_H - 152
    for title, lines in sections:
        if y < 130:
            break
        page.text(60, y, title, 11, "F2", MAROON)
        y -= 20
        for line in lines:
            if y < 110:
                break
            page.text(74, y, line, 10, "F1", "0.22 0.22 0.26")
            y -= 15
        y -= 12

    page.line(60, 78, PAGE_W - 60, 78, "0.87 0.87 0.90")
    page.text(60, 62, "Himachal Pradesh University - Academic Portal", 8, "F1", "0.50 0.50 0.55")
    page.right(62, f"Page {page_no}", 8)
    return page


def wrap(value: str, width: int) -> list[str]:
    words, lines, current = value.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def build_question_paper(code: str, subject: str, year: int, sections: list[str]) -> bytes:
    tag = f"HPU/EXAM/BTECH-CSE/{year % 100}/{code}"
    page_1 = cover(
        f"{code} — {subject}",
        f"End-Term Final Examination · Academic Session {year - 1}–{year} · "
        f"Maximum Marks 100 · Time 3 Hours",
        "Department of Computer Science & Engineering",
        f"QUESTION PAPER · {tag}",
    )

    pages = [page_1]
    page_no = 2
    cursor = 0
    chunk_size = 6
    while cursor < len(sections):
        block = sections[cursor:cursor + chunk_size]
        body: list[tuple[str, list[str]]] = []
        for offset, question in enumerate(block):
            number = cursor + offset + 1
            body.append((f"Q{number}.  ({number} x 5 = 5 marks)", wrap(question, 78)))
        pages.append(content_page(
            f"{code} — QUESTION PAPER {year}", body,
            f"End-Term Final Examination · {subject}", page_no,
        ))
        cursor += chunk_size
        page_no += 1
    return build_pdf(pages, f"{code} Question Paper {year}",
                    "Himachal Pradesh University", subject)


def build_textbook_stub(title: str, authors: str, publisher: str, pages: int,
                        chapters: list[str]) -> bytes:
    page_1 = cover(
        title,
        f"{authors} · {publisher} · {pages} pages · E-Library licensed copy",
        "Department of Computer Science & Engineering",
        "E-LIBRARY RESOURCE",
    )
    pages_out = [page_1]
    for index in range(0, len(chapters), 5):
        body = [(f"Chapter {n + 1}", wrap(chapters[n], 78))
                for n in range(index, min(index + 5, len(chapters)))]
        pages_out.append(content_page(
            "TABLE OF CONTENTS", body, title[:64], len(pages_out) + 1,
        ))
    return build_pdf(pages_out, title, authors, "E-Library resource")


def build_worksheet_template() -> bytes:
    page = Page()
    page.rect(0, PAGE_H - 120, PAGE_W, 120, "0.42 0.09 0.20")
    page.text(60, PAGE_H - 56, "HIMACHAL PRADESH UNIVERSITY", 16, "F2", "1 1 1")
    page.text(60, PAGE_H - 80, "SHIMLA - 171001", 9, "F1", "0.92 0.88 0.86")
    page.text(60, PAGE_H - 102, "SUBJECT WORKSHEET - OFFICIAL FORMAT", 10, "F2", "1 0.94 0.90")

    page.text(60, PAGE_H - 150, "SUBMISSION COVER SHEET", 13, "F2", "0.10 0.10 0.12")
    fields = [
        ("Student Name", "_______________________________________________"),
        ("Roll Number", "_______________________________________________"),
        ("Registration No.", "_______________________________________________"),
        ("Semester / Batch", "_______________________________________________"),
        ("Subject & Code", "_______________________________________________"),
        ("Faculty Name", "_______________________________________________"),
        ("Worksheet Title", "_______________________________________________"),
        ("Date of Submission", "_______________________________________________"),
    ]
    y = PAGE_H - 186
    for label, rule in fields:
        page.text(60, y, label, 10, "F2", MAROON)
        page.text(210, y, rule, 10, "F4", "0.35 0.35 0.40")
        y -= 26

    page.line(60, y - 4, PAGE_W - 60, y - 4, "0.87 0.87 0.90")
    page.text(60, y - 26, "MARKS AWARDED BY FACULTY", 11, "F2", MAROON)
    page.rect(60, y - 190, PAGE_W - 120, 150, "0.97 0.97 0.98", "0.87 0.87 0.90")
    grid_top = y - 58
    for row in range(1, 7):
        page.line(72, grid_top - row * 21, PAGE_W - 72, grid_top - row * 21,
                  "0.90 0.90 0.93", 0.5)
    page.text(76, grid_top + 8, "MAXIMUM MARKS", 8, "F2", "0.40 0.40 0.45")
    page.text(240, grid_top + 8, "OBTAINED", 8, "F2", "0.40 0.40 0.45")
    page.text(400, grid_top + 8, "REMARKS", 8, "F2", "0.40 0.40 0.45")

    page.line(60, 96, PAGE_W - 60, 96, "0.87 0.87 0.90")
    page.text(60, 78, "Submit this worksheet through the HPU Academic Portal before the deadline.",
              8, "F1", "0.50 0.50 0.55")
    page.text(60, 64, "Late submissions attract penalty as per university regulations.",
              8, "F1", "0.50 0.50 0.55")
    return build_pdf([page], "HPU Official Worksheet Template",
                     "HPU Examination Cell", "Worksheet submission format")


def build_format_sheet() -> bytes:
    page = Page()
    page.rect(0, PAGE_H - 110, PAGE_W, 110, "0.42 0.09 0.20")
    page.text(60, PAGE_H - 52, "HIMACHAL PRADESH UNIVERSITY", 15, "F2", "1 1 1")
    page.text(60, PAGE_H - 78, "SUBJECT WORKSHEET - SOLUTION FORMAT SHEET", 10, "F2", "1 0.94 0.90")
    page.text(60, PAGE_H - 96, "Department of Computer Science & Engineering", 9, "F1", "0.92 0.88 0.86")

    y = PAGE_H - 150
    for heading, lines in [
        ("1. STUDENT IDENTIFICATION", [
            "Write your full name in block capitals as registered with the",
            "university, followed by your roll number and registration number.",
        ]),
        ("2. WORKING FORMAT", [
            "Each worksheet question must be attempted in the space provided.",
            "Answers should be concise, technically precise and legible.",
            "Diagrams must be labelled and referenced from the written answer.",
            "Use of loose sheets is not permitted. Staple pages in order.",
        ]),
        ("3. PL/SQL SPECIFIC GUIDELINES", [
            "All PL/SQL blocks must execute without compilation warnings.",
            "Include SERVEROUTPUT feedback in the script header.",
            "Every procedure and package must be accompanied by its DDL script.",
            "Submit the .sql script alongside the handwritten worksheet.",
        ]),
        ("4. EVALUATION CRITERIA", [
            "Correctness of the technical solution .............. 40 marks",
            "Presentation, structure and readability ............. 25 marks",
            "Diagrams, tables and worked examples ................ 20 marks",
            "Timely submission before the deadline .............. 15 marks",
        ]),
        ("5. SUBMISSION", [
            "Upload a single PDF file through the portal worksheet tab.",
            "File name: ROLLNO_SUBJECTCODE_WORKSHEETNUMBER.PDF",
            "Maximum file size: 8 MB. Only PDF format is accepted.",
        ]),
    ]:
        page.text(60, y, heading, 11, "F2", "0.42 0.09 0.20")
        y -= 18
        for line in lines:
            page.text(74, y, line, 10, "F1", "0.22 0.22 0.26")
            y -= 15
        y -= 10

    page.line(60, 92, PAGE_W - 60, 92, "0.87 0.87 0.90")
    page.text(60, 74, "HPU Academic Council - Academic Session 2025-2026", 8, "F1", "0.50 0.50 0.55")
    return build_pdf([page], "HPU Worksheet Solution Format Sheet",
                     "HPU Examination Cell", "Worksheet writing format")


def build_lab_manual() -> bytes:
    experiments = [
        ("EXPERIMENT 1", [
            "Design and implement normalisation of a flattened sales schema.",
            "Demonstrate 1NF, 2NF, 3NF and BCNF with lossless-join proof.",
        ]),
        ("EXPERIMENT 2", [
            "Write a PL/SQL package that records every DML change using a",
            "compound trigger, and prove the audit trail is append-only.",
        ]),
        ("EXPERIMENT 3", [
            "Simulate a distributed transaction between two nodes using",
            "two-phase commit, then force a coordinator failure to observe",
            "the recovery path.",
        ]),
        ("EXPERIMENT 4", [
            "Benchmark an OLTP workload with and without a covering index,",
            "reading the execution plan before and after.",
        ]),
        ("EXPERIMENT 5", [
            "Implement a GPU ray-tracing pipeline and compare its frame",
            "time against a CPU reference implementation.",
        ]),
        ("EXPERIMENT 6", [
            "Build a small neural network, train it on the supplied",
            "dataset, and report the learning curve with your results.",
        ]),
    ]
    page_1 = cover(
        "B.TECH CSE SEMESTER VI LAB MANUAL & PROTOCOLS",
        "Advanced Database Systems · Computer Networks · Machine Learning · "
        "Full-Stack Web Engineering · Cloud Computing · Graphics Laboratory",
        "Academic Council, Himachal Pradesh University",
        "OFFICIAL LABORATORY MANUAL · SESSION 2025-2026",
    )
    body = [(name, lines) for name, lines in experiments]
    page_2 = content_page("LIST OF EXPERIMENTS", body,
                          "Semester VI Laboratory Manual", 2)
    marks = [("MARKS DISTRIBUTION", [
        "Source code and configuration ............... 20 marks",
        "Experiment record and observation ......... 20 marks",
        "Viva voce and demonstration ................ 10 marks",
    ]), ("LAB SAFETY", [
        "Back up all databases before running destructive scripts.",
        "Never commit credentials into a repository.",
        "Report hardware failure to the lab-in-charge immediately.",
    ])]
    page_3 = content_page("MARKING AND SAFETY", marks, "Semester VI Laboratory Manual", 3)
    return build_pdf([page_1, page_2, page_3],
                     "HPU B.Tech CSE Semester VI Lab Manual",
                     "Department of Computer Science & Engineering, HPU",
                     "Laboratory manual")


def build_syllabus(code: str, name: str, topics: list[str]) -> bytes:
    body: list[tuple[str, list[str]]] = []
    per_unit = max(1, len(topics) // 5)
    unit = 1
    for index in range(0, len(topics), per_unit):
        body.append((f"UNIT {unit}",
                     [f"{n + 1}. {topics[n]}" for n in
                      range(index, min(index + per_unit, len(topics)))][:6]))
        unit += 1
    body.append(("ASSESSMENT", [
        "Internal assessment: 20 marks (assignments, worksheets, seminars)",
        "Mid-term examination: 30 marks",
        "End-term examination: 50 marks",
        "Attendance requirement: 75 percent in every subject to be eligible",
        "to appear in the end-term examination.",
    ]))
    pages = [
        cover(f"{code} — {name}",
              "Subject syllabus · B.Tech Computer Science & Engineering · "
              "Semester VI · 4 Credits",
              "Department of Computer Science & Engineering",
              "SUBJECT SYLLABUS"),
        content_page(f"{code} SYLLABUS", body, f"{code} {name[:44]}", 2),
    ]
    return build_pdf(pages, f"{code} Syllabus", "HPU CSE Department", name)


def build_paper(paper_id: str, authors: str, publisher: str, venue: str,
                abstract: list[str], sections: list[str]) -> bytes:
    body = [("ABSTRACT", abstract)]
    for index, section in enumerate(sections, start=1):
        body.append((f"{index}. {section}",
                     wrap(f"This section develops the argument set out in the study, "
                          f"reporting the method, the observations and the limits of "
                          f"the analysis as published in {venue}.", 78)))
    pages = [
        cover(paper_id, f"{authors} · {venue}", authors, "E-LIBRARY · RESEARCH PAPER"),
        content_page(paper_id, body, f"{venue} · {paper_id}", 2),
    ]
    return build_pdf(pages, paper_id, authors, venue)


# ----------------------------------------------------------------------------
#  Registry
# ----------------------------------------------------------------------------
DOCUMENTS: dict[str, callable] = {}


def register(name: str):
    def decorator(fn):
        DOCUMENTS[name] = fn
        return fn
    return decorator


CS601 = "ADVANCED DATABASE SYSTEMS & PL/SQL"
CS602 = "COMPUTER NETWORKS & CYBER SECURITY"
CS603 = "MACHINE LEARNING & AI SYSTEMS"
CS604 = "FULL-STACK WEB ENGINEERING"
CS605 = "CLOUD COMPUTING ARCHITECTURE"
CS606 = "HIGH PERFORMANCE GRAPHICS LAB"

register("PYQ_CS601_2025.pdf")(lambda: build_question_paper(
    "CS-601", "ADVANCED DATABASE SYSTEMS & PL/SQL", 2025, [
        "Explain the Armstrong axioms and use them to prove a relation is in BCNF.",
        "Differentiate between 2PL, strict 2PL and rigourous 2PL schedules, and show that strict 2PL guarantees recoverability.",
        "Write a PL/SQL trigger that enforces a column-level constraint on HPU_ENROLLMENT and explain why a row-level trigger alone is insufficient.",
        "Describe the two-phase commit protocol with a full state diagram, and explain how a coordinator failure is recovered.",
        "Compare vertical and horizontal partitioning strategies for a distributed warehouse, with reference to CAP.",
        "Explain how a cost-based optimiser chooses between an index scan, an index range scan and a full table scan.",
        "What is a covering index? Demonstrate, with an execution plan, how it removes table lookups.",
        "Describe write-ahead logging and justify the WAL rule using the buffer manager replacement policy.",
        "Explain optimistic versus pessimistic concurrency control, and give one workload where each is the better choice.",
        "Discuss query tuning for a star schema: bitmap indexes, materialised views and predicate pushdown.",
        "Explain sharding strategies and the cross-shard join problem, including scatter-gather and broadcast joins.",
        "Write a PL/SQL package with a record type and a cursor returning a ref cursor, then use it from a query.",
        "Explain how a NoSQL document store relaxes normalisation, and when that relaxation is justified.",
        "Discuss transaction isolation levels and enumerate every anomaly each level permits.",
        "Describe how MVCC enables readers to proceed while a writer is active.",
        "Explain the role of a connection pool in a three-tier deployment, and size it for a given workload.",
        "Differentiate OLTP from OLAP, and justify two indexes that suit each.",
        "Explain how a log-structured merge tree differs from a B-tree for write-heavy workloads.",
        "Discuss the CAP theorem with a concrete partition example during a network partition.",
        "Explain referential integrity enforcement via declarative constraints versus triggers, and when each is preferable.",
    ]))

register("PYQ_CS602_2025.pdf")(lambda: build_question_paper(
    "CS-602", "COMPUTER NETWORKS & CRYPTOGRAPHY", 2025, [
        "Describe the OSI and TCP/IP stacks, mapping every layer, and justify the layer count.",
        "Explain the TCP three-way handshake and the mechanics of TIME_WAIT, including why it exists.",
        "Differentiate between TCP congestion control algorithms: slow start, congestion avoidance, fast recovery.",
        "Explain BGP path selection, route reflection, and why BGP is a path vector protocol.",
        "Describe the RSA cryptosystem, including key generation, encryption and the trapdoor argument for security.",
        "Compare AES-128 and AES-256, explaining the key schedule, rounds and the SubBytes, ShiftRows, MixColumns and AddRoundKey steps.",
        "Trace the full TLS 1.3 handshake, listing every message, extension and key derivation step.",
        "Explain certificate pinning, certificate transparency and the role of a certificate authority.",
        "Describe how a stateless firewall inspects traffic, and how a stateful firewall builds its connection table.",
        "Explain intrusion detection: signature-based versus anomaly-based, with detection rate and false positive trade-offs.",
        "Describe DNS and DNSSEC, including how a resolver validates a chain of trust.",
        "Explain how DHCP allocates addresses through DORA, and what happens when the lease expires.",
        "Describe virtual private tunnels, the difference between GRE and IPsec, and the security association table.",
        "Explain how HTTP/2 multiplexing removes head-of-line blocking, and how HTTP/3 improves on it further.",
        "Discuss Wi-Fi security: WEP, WPA, WPA2 and WPA3, with the handshake differences that matter.",
        "Explain ARP spoofing, how it is detected, and two mitigations.",
        "Describe network address translation, port address translation and hairpinning.",
        "Explain QUIC's use of UDP, its stream multiplexing, and its 0-RTT handshake risk.",
        "Discuss ethical considerations of offensive security work and responsible disclosure.",
        "Explain zero-trust networking with respect to identity, least privilege and micro-segmentation.",
    ]))

register("PYQ_CS603_2024.pdf")(lambda: build_question_paper(
    "CS-603", "MACHINE LEARNING & DEEP NEURAL NETWORKS", 2024, [
        "Differentiate supervised, unsupervised and reinforcement learning with one example of each.",
        "Derive the gradient of the logistic loss function and explain the role of the sigmoid saturation.",
        "Explain bias-variance trade-off and describe three regularisation techniques.",
        "Derive backpropagation for a feed-forward network, writing the chain rule at each layer.",
        "Explain vanishing gradients and the architectural choices that mitigate them.",
        "Explain batch normalisation, layer normalisation and group normalisation.",
        "Explain why CNNs exploit spatial locality, and the role of pooling versus strided convolution.",
        "Describe the residual connection and show how it changes the gradient flow.",
        "Explain the self-attention mechanism and derive the complexity of attention in terms of sequence length.",
        "Describe multi-head attention and the role of positional encodings in transformers.",
        "Explain the bias-variance behaviour of the bias-variance decomposition in ensemble learning.",
        "Compare bagging and boosting with respect to variance and bias reduction.",
        "Describe ROC-AUC and precision-recall curves, and when precision-recall is preferable.",
        "Explain the confusion matrix and compute accuracy, precision, recall and F1 for a supplied dataset.",
        "Describe cross-validation strategies and when a time-series split is required.",
        "Explain the curse of dimensionality and how regularisation mitigates it.",
        "Describe generative adversarial networks, including the minimax objective.",
        "Explain model deployment considerations: latency, drift, monitoring and rollback.",
        "Describe k-means clustering and the elbow method for choosing k.",
        "Explain transfer learning, fine-tuning and layer freezing.",
    ]))

register("PYQ_CS604_2025.pdf")(lambda: build_question_paper(
    "CS-604", "FULL-STACK WEB ENGINEERING", 2025, [
        "Describe the request lifecycle of a modern single-page application, from DNS to paint.",
        "Explain CSS specificity and the cascade, resolving a conflicting-styles example.",
        "Describe the event loop and explain why long tasks block rendering.",
        "Differentiate optimistic and pessimistic UI updates, and give one case for each.",
        "Explain REST resource modelling, including idempotency and safe methods.",
        "Describe token-based authentication, refresh rotation, and token revocation.",
        "Compare cookie sessions with JWTs for a web application, including attack surface.",
        "Explain CSRF and how SameSite cookies plus custom headers mitigate it.",
        "Describe browser storage: cookies, localStorage, sessionStorage and IndexedDB, and their threat models.",
        "Explain server-side rendering, hydration, and the trade-offs of each.",
        "Describe caching layers: HTTP cache headers, service worker, and CDN edge caching.",
        "Explain performance metrics such as LCP, INP and CLS, and how to reduce each.",
        "Describe image optimisation strategies including responsive images and modern formats.",
        "Explain database indexing as it applies to a read-heavy web workload.",
        "Describe input validation, output encoding and content security policy.",
        "Explain dependency supply-chain risk and lockfile-based reproducible builds.",
        "Describe progressive enhancement and why it improves resilience.",
        "Explain internationalisation, localisation and time zone handling.",
        "Describe structured logging and distributed request tracing.",
        "Explain rate limiting, backpressure and circuit breaking for a public API.",
    ]))

register("PYQ_CS606_2025.pdf")(lambda: build_question_paper(
    "CS-606", "COMPUTER GRAPHICS PIPELINES & RAY TRACING", 2025, [
        "Describe the complete graphics pipeline from application to framebuffer.",
        "Differentiate rasterisation from ray tracing in terms of visibility and shading cost.",
        "Explain the transformation pipeline: model, view, projection and viewport.",
        "Explain the depth buffer algorithm, its precision limits and z-fighting.",
        "Describe back-face culling, frustum culling and occlusion culling.",
        "Explain Phong and Gouraud shading, and where each performs interpolation.",
        "Derive the physically based rendering reflectance equation and BRDF terms.",
        "Explain ray-sphere and ray-triangle intersection tests.",
        "Describe ray tracing acceleration structures: bounding volume hierarchy, uniform grid, k-D tree.",
        "Explain Monte Carlo path tracing, importance sampling and noise convergence.",
        "Describe the graphics pipeline of Vulkan or OpenGL compute, including barrier placement.",
        "Explain GPU memory hierarchy, occupancy and shared-memory banking.",
        "Describe tessellation stages: hull, domain and geometry.",
        "Explain colour spaces, gamma correction and tone mapping.",
        "Describe texture sampling, mipmapping, anisotropy and aliasing.",
        "Explain GPU-driven rendering and indirect draw.",
        "Describe temporal anti-aliasing and reprojection.",
        "Explain image-space effects: bloom, depth of field and motion blur.",
        "Describe curve and surface representation, including Bézier and B-spline forms.",
        "Explain how virtual reality rendering differs from flat display rendering.",
    ]))

register("HPU_WORKSHEET_TEMPLATE.pdf")(build_worksheet_template)
register("HPU_WORKSHEET_FORMAT_SHEET.pdf")(build_format_sheet)
register("HPU_SEM6_LAB_MANUAL_2026.pdf")(build_lab_manual)

register("HPU_OFFICIAL_COVER_PAGE_TEMPLATE.pdf")(lambda: build_pdf(
    [cover("HIMACHAL PRADESH UNIVERSITY",
           "Official emblem cover page for B.Tech Computer Science & Engineering "
           "theory and practical submissions · Academic Session 2025-2026",
           "Academic Council, Himachal Pradesh University",
           "SUBMISSION COVER PAGE TEMPLATE")],
    "HPU Official Cover Page Template", "HPU Examination Cell",
    "Cover page template"))

register("SYLLABUS_CS601.pdf")(lambda: build_syllabus("CS-601", CS601, [
    "Relational algebra and relational calculus",
    "Functional dependencies and Armstrong axioms",
    "Normalisation: 1NF, 2NF, 3NF, BCNF and lossless joins",
    "PL/SQL blocks, cursors, procedures, functions and packages",
    "Exception handling and bulk operations",
    "Triggers: row-level, statement-level and compound triggers",
    "Transaction management and ACID properties",
    "Concurrency control: 2PL, strict 2PL, MVCC and OCC",
    "Distributed transactions and the two-phase commit protocol",
    "Recovery, write-ahead logging and checkpoints",
    "Query processing, cost-based optimisation and execution plans",
    "Indexing strategies: B-tree, hash, bitmap and covering indexes",
    "Partitioning, sharding and distributed query processing",
    "NoSQL document stores and eventual consistency",
]))

register("SYLLABUS_CS602.pdf")(lambda: build_syllabus("CS-602", CS602, [
    "Network architectures: OSI and TCP/IP models",
    "Physical, data link and MAC sublayers",
    "Error detection and correction, flow and congestion control",
    "TCP/IP stack, routing and the address resolution protocol",
    "Distance-vector and path-vector routing protocols",
    "Border Gateway Protocol, route reflection and policy",
    "Numbering and addressing: IPv4, IPv6, NAT and DHCP",
    "Public-key cryptography: RSA, Diffie-Hellman and elliptic curves",
    "Symmetric cryptography: DES, AES and modes of operation",
    "Hashing, digital signatures and message authentication codes",
    "Transport layer security: the TLS 1.3 handshake",
    "Public key infrastructure, certificates and transparency",
    "Firewalls, proxies, intrusion detection and virtual private networks",
    "Web and application layer protocols, HTTP/2 and QUIC",
    "Wireless networking and Wi-Fi security",
]))

register("SYLLABUS_CS603.pdf")(lambda: build_syllabus("CS-603", CS603, [
    "Supervised learning: regression, classification and decision boundaries",
    "Linear models, logistic regression and loss functions",
    "Regularisation, bias-variance trade-off and model selection",
    "Ensemble learning: bagging, boosting and random forests",
    "Support vector machines and kernel methods",
    "Neural network architecture, forward pass and backpropagation",
    "Optimisation: gradient descent variants and learning rate schedules",
    "Convolutional neural networks and computer vision pipelines",
    "Recurrent networks, attention and sequence models",
    "Transformers, self-attention and large language model fundamentals",
    "Unsupervised learning: clustering, dimensionality reduction and embeddings",
    "Generative models and adversarial training",
    "Model evaluation metrics, cross-validation and experiment design",
    "Deployment, monitoring, drift detection and rollback",
]))

register("SYLLABUS_CS604.pdf")(lambda: build_syllabus("CS-604", CS604, [
    "Modern frontend architecture and the rendering pipeline",
    "Semantic HTML, modern CSS layout and design systems",
    "JavaScript language fundamentals, modules and the event loop",
    "Asynchronous programming, promises and error handling",
    "RESTful service design, resource modelling and versioning",
    "Authentication, authorisation, sessions and tokens",
    "Security: CSRF, XSS, CSP and secure cookie policy",
    "Server-side rendering, hydration and progressive enhancement",
    "Performance: caching layers, code splitting and core web vitals",
    "Testing strategy: unit, integration and end-to-end",
    "Observability: structured logging and distributed tracing",
    "Reliability: rate limiting, retries, backpressure and circuit breakers",
]))

register("SYLLABUS_CS605.pdf")(lambda: build_syllabus("CS-605", CS605, [
    "Virtualisation, hypervisors and hardware-assisted virtualisation",
    "Server consolidation, live migration and high availability",
    "Container runtimes, image layers and the registry model",
    "Orchestration with Kubernetes: pods, deployments and services",
    "Service discovery, load balancing and service meshes",
    "Microservices decomposition, data ownership and sagas",
    "Serverless computing, cold starts and cost characteristics",
    "Infrastructure as code, immutable infrastructure and drift detection",
    "Observability: metrics, logs, traces and SLOs",
    "Reliability engineering: SLIs, SLOs, error budgets and incident response",
    "Storage: object, block and distributed file systems",
    "Security: identity, secrets management and network policy",
]))

register("SYLLABUS_CS606.pdf")(lambda: build_syllabus("CS-606", CS606, [
    "Graphics pipeline stages and rasterisation",
    "2D and 3D transformations, projection and the view frustum",
    "Fill rules, clipping and the depth buffer",
    "Visible surface determination and culling strategies",
    "Lighting models, shading and interpolation",
    "Physically based rendering and the BRDF",
    "Ray casting, ray tracing and intersection tests",
    "Acceleration structures: BVH, k-D tree and uniform grids",
    "GPU programming model, shaders and the compute pipeline",
    "GPU memory hierarchy, occupancy and optimisation",
    "Tessellation, texture mapping and mipmapping",
    "Colour spaces, tone mapping and post-processing effects",
]))

register("DATABASE_SYSTEM_CONCEPTS_7E.PDF")(lambda: build_textbook_stub(
    "DATABASE SYSTEM CONCEPTS", "SILBERSCHATZ, KORTH & SUDARSHAN",
    "McGraw-Hill", 1376, [
        "Database environments and development process",
        "The relational model and relational calculus",
        "SQL: schema definition, queries and modification",
        "Advanced SQL: joins, aggregation, window functions and views",
        "Functional dependencies and normalisation",
        "Storage and indexing: B-tree, hash and multi-dimensional indexes",
        "Query processing and optimisation",
        "Transactions, concurrency control and recovery",
        "Database design: entity-relationship modelling",
        "Physical database design and performance tuning",
        "Distributed databases, sharding and replication",
        "Big data: MapReduce, stream processing and data warehouses",
        "Information retrieval and search engine internals",
        "Special-purpose databases: object, spatial and temporal",
    ]))

register("COMPUTER_NETWORKING_TOP_DOWN_8E.PDF")(lambda: build_textbook_stub(
    "COMPUTER NETWORKING: A TOP-DOWN APPROACH", "KUROSE & ROSS",
    "Pearson", 848, [
        "Network overview and the layered design philosophy",
        "The network layer: datagram and virtual circuit networks",
        "The IP address, routing and forwarding",
        "The link layer, error detection and multiple access",
        "Wireless and mobile networks",
        "Transport layer: the connectionless and connection-oriented approaches",
        "TCP congestion control",
        "The application layer and modern networked applications",
        "Security in the application, transport and network layers",
        "Network media, physical layer and radio spectrum",
    ]))

register("PATTERN_RECOGNITION_ML_BISHOP.PDF")(lambda: build_textbook_stub(
    "PATTERN RECOGNITION AND MACHINE LEARNING",
    "CHRISTOPHER M. BISHOP", "Springer", 758, [
        "Probability distributions and the exponential family",
        "Gaussian distribution and the multivariate case",
        "Bayesian inference, prior and posterior",
        "Linear models for regression and classification",
        "Neural networks and the backpropagation algorithm",
        "Markov chains and graphical models",
        "Gibbs sampling and variational inference",
        "Support vector machines and kernel methods",
        "Gaussian processes",
        "Variational inference and modern deep learning",
        "Deep learning architectures and representation learning",
    ]))

register("HPU_CLOUD_WEB_LECTURE_NOTES.PDF")(lambda: build_pdf(
    [cover("FULL-STACK CLOUD ARCHITECTURES & REST APIS",
           "Compiled lecture notes by Dr. Neha Gupta and Er. Sumit Sharma · "
           "Department of Computer Science & Engineering · HPU · Session 2025-2026",
           "Department of Computer Science & Engineering",
           "OFFICIAL DEPARTMENTAL LECTURE NOTES"),
     content_page("COURSE MAP", [
         ("UNIT 1 - WEB FOUNDATIONS", [
             "HTTP semantics, methods, status codes and content negotiation.",
             "REST resource modelling, statelessness and cacheability.",
             "Versioning strategies and backwards compatibility.",
         ]),
         ("UNIT 2 - AUTHENTICATION & SECURITY", [
             "Password storage: PBKDF2, scrypt and Argon2.",
             "HS256 JSON Web Tokens: header, payload and signature.",
             "Session revocation, CSRF, and secure cookie policy.",
         ]),
         ("UNIT 3 - MICROSERVICES", [
             "Decomposition by domain, data ownership and sagas.",
             "Service-to-service authentication and mTLS.",
             "Circuit breaking, retries with backoff and idempotency keys.",
         ]),
         ("UNIT 4 - CONTAINERS & ORCHESTRATION", [
             "Layer caching, image layers and multi-stage builds.",
             "Kubernetes pods, deployments, services and probes.",
             "Horizontal pod autoscaling and readiness gates.",
         ]),
         ("UNIT 5 - RELIABILITY & COST", [
             "SLIs, SLOs, error budgets and burn-rate alerting.",
             "Autoscaling economics and spot capacity trade-offs.",
             "FinOps: tagging, showback and chargeback.",
         ]),
     ], "Cloud & Full-Stack Engineering", 2)],
    "Full-Stack Cloud Architectures & REST APIs",
    "Dr. Neha Gupta & Er. Sumit Sharma", "Lecture notes"))

register("IEEE_TKDE_THAKUR_DISTRIBUTED_DB.PDF")(lambda: build_paper(
    "DISTRIBUTED DATABASE CONCURRENCY CONTROL & RECOVERY",
    "PROF. R.S. THAKUR", "IEEE Transactions on Knowledge and Data Engineering",
    "Published in the IEEE Transactions on Knowledge and Data Engineering",
    [
        "A cluster of commodity database nodes frequently stalls when a single",
        "coordinator fails midway through a distributed commit. This paper",
        "evaluates a recovery-oriented variant of two-phase commit that",
        "replaces the blocking decision of the original protocol with a",
        "bounded, non-blocking presumed-abort rule, and measures the effect",
        "on coordinator recovery latency under skewed contention.",
    ],
    [
        "BACKGROUND AND RELATED WORK",
        "THE PROPOSED RECOVERY RULE",
        "PRESUMED ABORT VERSUS PRESUMED COMMIT",
        "FAILURE INJECTION AND WORKLOAD",
        "RESULTS AND SENSITIVITY",
        "CONCLUSION AND FUTURE WORK",
    ]))

register("PARALLEL_PROGRAMMING_CUDA.pdf")(lambda: build_textbook_stub(
    "PARALLEL PROGRAMMING WITH CUDA", "KIRK & HWANG", "Elsevier", 592, [
        "Parallel computing architectures and the GPU programming model",
        "Threads, blocks, warps and the execution model",
        "Memory hierarchy: global, shared, constant and texture memory",
        "Coalescing, bank conflicts and memory coalescing",
        "Performance analysis: arithmetic intensity and the roofline model",
        "Parallel algorithm patterns: mapping, tiling and reduction",
        "Concurrent kernel execution and stream semantics",
        "Optimisation techniques for occupancy and latency hiding",
        "Numerical computing: FFT, reduction and dense linear algebra",
        "Parallel computing with CUDA libraries and multi-GPU scaling",
    ]))

register("DESIGNING_DATA_INTENSIVE_APPS.pdf")(lambda: build_textbook_stub(
    "DESIGNING DATA-INTENSIVE APPLICATIONS", "MARTIN KLEPPMANN",
    "O'Reilly", 616, [
        "Introduction to reliable, scalable and maintainable systems",
        "Reliable software: failure modes and fault tolerance",
        "Scaling up and scaling out",
        "Replication: leader-follower, multi-leader and leaderless",
        "Partitioning: key, hash and range partitioning",
        "Transactions and the trouble with distributed databases",
        "Distributed systems trouble: partial failure and asynchronous networks",
        "Consistency and replication: CAP, linearisability and quorums",
        "Batch processing and stream processing",
        "Data formats, encoding and compression",
    ]))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, builder in sorted(DOCUMENTS.items()):
        data = builder()
        (OUT / name).write_bytes(data)
        total += len(data)
        print(f"  {name:<44} {len(data):>8,} bytes")
    print(f"\n{len(DOCUMENTS)} documents, {total:,} bytes -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())