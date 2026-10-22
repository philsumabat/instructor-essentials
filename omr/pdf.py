"""PDF Ingestion Module for OMR Exam Grading.

Extracts pages from scanned PDF documents into OpenCV BGR numpy arrays.
Supports multi-page scan PDFs from mobile scanners (Adobe Scan, CamScanner, etc.)
and flatbed/sheet-fed office scanners.
"""
from __future__ import annotations

import re
from pathlib import Path

import cv2
import numpy as np


class PDFError(RuntimeError):
    """Raised when PDF extraction or parsing fails."""


def is_pdf(path_or_name: str | Path) -> bool:
    """Checks whether the file path or name indicates a PDF file."""
    p = Path(path_or_name)
    if p.suffix.lower() == ".pdf":
        return True
    if p.exists() and p.is_file():
        try:
            with open(p, "rb") as fh:
                header = fh.read(5)
                return header.startswith(b"%PDF-")
        except Exception:
            return False
    return False


def extract_pdf_pages(
    pdf_path: str | Path,
    dpi: float = 300.0,
) -> list[tuple[str, np.ndarray]]:
    """Extracts all pages from a PDF document as OpenCV BGR numpy arrays.

    Returns:
        List of (page_name, bgr_image) tuples.
        page_name format: {stem}_p{page_num:03d}
    """
    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF file not found: {path}")

    has_engine = False
    stem = path.stem
    last_error: Exception | None = None

    # Strategy 1: pypdfium2 (preferred, fast Chromium PDFium engine)
    try:
        import pypdfium2 as pdfium  # type: ignore

        has_engine = True
        doc = pdfium.PdfDocument(str(path))
        num_pages = len(doc)
        if num_pages == 0:
            raise PDFError(f"PDF '{path.name}' contains no pages.")

        pad = max(3, len(str(num_pages)))
        scale = dpi / 72.0
        pages: list[tuple[str, np.ndarray]] = []
        for idx in range(num_pages):
            page = doc[idx]
            bitmap = page.render(scale=scale)
            # pypdfium2 bitmap.to_numpy() returns uint8 BGR array
            arr = bitmap.to_numpy()
            if arr.shape[2] == 4:
                arr = cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
            page_name = f"{stem}_p{idx + 1:0{pad}d}"
            pages.append((page_name, arr))
        return pages
    except PDFError:
        raise
    except ImportError:
        pass
    except Exception as exc:
        last_error = exc

    # Strategy 2: PyMuPDF (fitz)
    try:
        import fitz  # type: ignore

        has_engine = True
        doc = fitz.open(str(path))
        num_pages = len(doc)
        if num_pages == 0:
            raise PDFError(f"PDF '{path.name}' contains no pages.")

        pad = max(3, len(str(num_pages)))
        pages = []
        for idx in range(num_pages):
            page = doc[idx]
            pix = page.get_pixmap(dpi=dpi)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                bgr = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif pix.n == 3:
                bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            elif pix.n == 1:
                bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
            else:
                bgr = img
            page_name = f"{stem}_p{idx + 1:0{pad}d}"
            pages.append((page_name, bgr))
        return pages
    except PDFError:
        raise
    except ImportError:
        pass
    except Exception as exc:
        last_error = exc

    # Strategy 3: pdf2image
    try:
        from pdf2image import convert_from_path  # type: ignore

        has_engine = True
        pil_images = convert_from_path(str(path), dpi=int(dpi))
        num_pages = len(pil_images)
        if num_pages == 0:
            raise PDFError(f"PDF '{path.name}' contains no pages.")

        pad = max(3, len(str(num_pages)))
        pages = []
        for idx, pil_img in enumerate(pil_images):
            rgb = np.array(pil_img)
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            page_name = f"{stem}_p{idx + 1:0{pad}d}"
            pages.append((page_name, bgr))
        return pages
    except PDFError:
        raise
    except ImportError:
        pass
    except Exception as exc:
        last_error = exc

    # Strategy 4: Pure-Python scanner stream extraction fallback
    # Scanners (Adobe Scan, etc.) wrap camera JPEG streams in simple PDF objects.
    try:
        pages = _extract_raw_scanner_streams(path)
        if pages:
            return pages
    except Exception as exc:
        last_error = exc

    if not has_engine:
        raise PDFError(
            f"Unable to render PDF '{path.name}'. "
            "Please ensure 'pypdfium2' is installed: pip install pypdfium2"
        )
    err_detail = f": {last_error}" if last_error else "."
    raise PDFError(f"Unable to render PDF '{path.name}' (document contains no renderable pages or is invalid){err_detail}")


def _get_obj_body(oid: int, obj_index: dict[int, int], latin1: str) -> str:
    start = obj_index.get(oid)
    if start is None:
        return ""
    end = latin1.find("endobj", start)
    return latin1[start:end] if end != -1 else latin1[start:]


def _get_stream_bytes(oid: int, obj_index: dict[int, int], latin1: str, raw_bytes: bytes) -> bytes | None:
    start = obj_index.get(oid)
    if start is None:
        return None
    st_tag = "stream"
    sp = latin1.find(st_tag, start)
    if sp == -1:
        return None
    d_start = sp + len(st_tag)
    if d_start < len(latin1) and latin1[d_start] == "\r":
        d_start += 1
    if d_start < len(latin1) and latin1[d_start] == "\n":
        d_start += 1
    end_sp = latin1.find("endstream", d_start)
    if end_sp == -1:
        return None
    d_end = end_sp
    while d_end > d_start and latin1[d_end - 1] in "\r\n":
        d_end -= 1
    return raw_bytes[d_start:d_end]


def _get_cm_rotation(content: str) -> int:
    m = re.search(r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm", content)
    if not m:
        return 0
    a, b, c, d = float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4))
    if abs(b) > abs(a):
        if b < 0 and c > 0:
            return 90
        if b > 0 and c < 0:
            return 270
    else:
        if a < 0 and d < 0:
            return 180
    return 0


def _parse_page_objects(obj_index: dict[int, int], latin1: str) -> tuple[list[dict], dict[int, dict]]:
    page_objs: list[dict] = []
    page_objs_map: dict[int, dict] = {}
    for oid, start in obj_index.items():
        body = _get_obj_body(oid, obj_index, latin1)
        if ("/Type/Page" in body or "/Type /Page" in body) and ("/Type/Pages" not in body and "/Type /Pages" not in body):
            rot = 0
            rot_m = re.search(r"/Rotate\s+(\d+)", body)
            if rot_m:
                rot = int(rot_m.group(1))

            cont_id = None
            cont_m = re.search(r"/Contents\s+(?:\[\s*)?(\d+)\s+\d+\s+R", body)
            if cont_m:
                cont_id = int(cont_m.group(1))

            img_id = None
            img_m = re.search(r"/XObject\s*<<[^\/]*\/[A-Za-z0-9_]+\s+(\d+)\s+\d+\s+R", body)
            if img_m:
                img_id = int(img_m.group(1))
            else:
                any_img = re.search(r"/Im\w*\s+(\d+)\s+\d+\s+R", body)
                if any_img:
                    img_id = int(any_img.group(1))
                else:
                    res_m = re.search(r"/Resources\s+(\d+)\s+\d+\s+R", body)
                    if res_m:
                        res_body = _get_obj_body(int(res_m.group(1)), obj_index, latin1)
                        sub_img = re.search(r"/XObject\s*<<[^\/]*\/[A-Za-z0-9_]+\s+(\d+)\s+\d+\s+R", res_body) or re.search(r"/Im\w*\s+(\d+)\s+\d+\s+R", res_body)
                        if sub_img:
                            img_id = int(sub_img.group(1))

            entry = {"id": oid, "rotate": rot, "contents_id": cont_id, "image_id": img_id}
            page_objs.append(entry)
            page_objs_map[oid] = entry
    return page_objs, page_objs_map


def _collect_page_ids(node_id: int, obj_index: dict[int, int], latin1: str, visited: set[int] | None = None) -> list[int]:
    if visited is None:
        visited = set()
    if node_id in visited:
        return []
    visited.add(node_id)
    b = _get_obj_body(node_id, obj_index, latin1)
    if not b:
        return []
    if ("/Type/Page" in b or "/Type /Page" in b) and ("/Type/Pages" not in b and "/Type /Pages" not in b):
        return [node_id]
    if "/Type/Pages" in b or "/Type /Pages" in b:
        km = re.search(r"/Kids\s*\[([^\]]+)\]", b)
        if not km:
            return []
        kids = [int(k) for k in re.findall(r"(\d+)\s+\d+\s+R", km.group(1))]
        result: list[int] = []
        for k in kids:
            result.extend(_collect_page_ids(k, obj_index, latin1, visited))
        return result
    return []


def _resolve_ordered_pages(obj_index: dict[int, int], latin1: str, page_objs: list[dict], page_objs_map: dict[int, dict]) -> list[dict]:
    ordered = page_objs
    root_pages_id = None
    for oid in obj_index:
        b = _get_obj_body(oid, obj_index, latin1)
        if "/Type/Catalog" in b or "/Type /Catalog" in b:
            pm = re.search(r"/Pages\s+(\d+)\s+\d+\s+R", b)
            if pm:
                root_pages_id = int(pm.group(1))
                break
    if root_pages_id is None:
        for oid in obj_index:
            b = _get_obj_body(oid, obj_index, latin1)
            if ("/Type/Pages" in b or "/Type /Pages" in b) and "/Parent" not in b:
                root_pages_id = oid
                break

    if root_pages_id is not None:
        leaf_ids = _collect_page_ids(root_pages_id, obj_index, latin1)
        resolved = [page_objs_map[lid] for lid in leaf_ids if lid in page_objs_map]
        if len(resolved) == len(page_objs):
            ordered = resolved

    return ordered


def _extract_raw_scanner_streams(path: Path) -> list[tuple[str, np.ndarray]]:
    """Fallback parser that extracts raw JPEG scanner streams and applies PDF rotation."""
    raw_bytes = path.read_bytes()
    latin1 = raw_bytes.decode("latin1", errors="replace")

    # Locate indirect objects
    obj_index: dict[int, int] = {}
    for m in re.finditer(r"(\d+)\s+(\d+)\s+obj", latin1):
        obj_index[int(m.group(1))] = m.start() + len(m.group(0))

    page_objs, page_objs_map = _parse_page_objects(obj_index, latin1)
    ordered = _resolve_ordered_pages(obj_index, latin1, page_objs, page_objs_map)

    if not ordered:
        return []

    stem = path.stem
    pad = max(3, len(str(len(ordered))))
    pages: list[tuple[str, np.ndarray]] = []

    for idx, p in enumerate(ordered):
        rot = p["rotate"]
        if p["contents_id"]:
            cbody = _get_obj_body(p["contents_id"], obj_index, latin1)
            rot = (rot + _get_cm_rotation(cbody)) % 360

        if not p["image_id"]:
            continue

        sbytes = _get_stream_bytes(p["image_id"], obj_index, latin1, raw_bytes)
        if not sbytes:
            continue

        # Decode JPEG bytes with OpenCV
        nparr = np.frombuffer(sbytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            continue

        if rot == 90:
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        elif rot == 180:
            img = cv2.rotate(img, cv2.ROTATE_180)
        elif rot == 270:
            img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)

        page_name = f"{stem}_p{idx + 1:0{pad}d}"
        pages.append((page_name, img))

    return pages
