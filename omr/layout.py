"""Typed view over ``layout.json`` produced by the browser sheet builder.

All coordinates are millimetres in the sheet's own frame (origin top-left).
The CV pipeline multiplies by ``px_per_mm`` to obtain canonical pixel
coordinates after perspective registration.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

LAYOUT_SCHEMA = "omr-layout/1"


class LayoutError(ValueError):
    """Raised when a layout file is missing data or uses an unknown schema."""


@dataclass(frozen=True)
class Bubble:
    value: str
    cx: float
    cy: float


@dataclass(frozen=True)
class BubbleGroup:
    """A set of bubbles of which (ideally) exactly one is filled."""

    key: str
    kind: str  # "sid" | "mcq" | "tf"
    label: str
    zone_id: str
    options: tuple[Bubble, ...]
    index: int | None = None  # digit position for student-ID columns

    @property
    def values(self) -> tuple[str, ...]:
        return tuple(o.value for o in self.options)


@dataclass(frozen=True)
class TextROI:
    id: str
    key: str
    label: str
    zone_id: str
    x: float
    y: float
    w: float
    h: float
    charset: str = "any"
    multiline: bool = False
    ocr: bool = True
    graded: bool = False
    points: float = 0.0
    role: str | None = None
    digits: int = 0


@dataclass(frozen=True)
class Fiducial:
    id: int
    corner: str
    size: float
    corners: tuple[tuple[float, float], ...]  # TL, TR, BR, BL in mm (ArUco order)


@dataclass(frozen=True)
class Zone:
    id: str
    type: str
    label: str
    bbox: tuple[float, float, float, float]
    groups: tuple[BubbleGroup, ...] = ()
    rois: tuple[TextROI, ...] = ()


@dataclass(frozen=True)
class Layout:
    template_id: str
    title: str
    paper: str
    page_width: float
    page_height: float
    dictionary: str
    fiducials: tuple[Fiducial, ...]
    bubble_diameter: float
    pitch_x: float
    pitch_y: float
    zones: tuple[Zone, ...]
    raw: dict = field(repr=False, compare=False, default_factory=dict)

    # ---- convenience views -------------------------------------------------
    @property
    def groups(self) -> list[BubbleGroup]:
        return [g for z in self.zones for g in z.groups]

    @property
    def sid_groups(self) -> list[BubbleGroup]:
        """Student-ID digit columns from the first student_id zone."""
        for z in self.zones:
            if z.type == "student_id":
                return sorted(z.groups, key=lambda g: g.index or 0)
        return []

    @property
    def question_groups(self) -> list[BubbleGroup]:
        return [g for g in self.groups if g.kind != "sid"]

    @property
    def rois(self) -> list[TextROI]:
        zone_rois = [r for z in self.zones for r in z.rois]
        if isinstance(self.raw, dict) and "rois" in self.raw and isinstance(self.raw["rois"], list):
            existing_ids = {r.id for r in zone_rois}
            for r in self.raw["rois"]:
                if r.get("id") not in existing_ids:
                    zone_rois.append(
                        TextROI(
                            id=r["id"],
                            key=str(r.get("key", r["id"])),
                            label=r.get("label", r.get("key", r["id"])),
                            zone_id="root",
                            x=float(r["x"]),
                            y=float(r["y"]),
                            w=float(r["w"]),
                            h=float(r["h"]),
                            charset=r.get("charset", "any"),
                            multiline=bool(r.get("multiline", False)),
                            ocr=bool(r.get("ocr", True)),
                            graded=bool(r.get("graded", False)),
                            points=float(r.get("points", 0) or 0),
                            role=r.get("role"),
                            digits=int(r.get("digits", 0) or 0),
                        )
                    )
        if isinstance(self.raw, dict) and "barcode" in self.raw and self.raw["barcode"].get("enabled", True):
            b = self.raw["barcode"]
            if not any(r.role in {"sheet_id", "barcode"} for r in zone_rois):
                zone_rois.append(
                    TextROI(
                        id="sheet_id",
                        key="sheet_id",
                        label="Sheet Barcode",
                        zone_id="root",
                        x=float(b.get("x", 0)),
                        y=float(b.get("y", 0)),
                        w=float(b.get("w", 34)),
                        h=float(b.get("h", 6.5)),
                        role="sheet_id",
                        graded=False,
                    )
                )
        return zone_rois

    @property
    def barcode_roi(self) -> TextROI | None:
        """Returns sheet barcode ROI if present."""
        for r in self.rois:
            if (
                r.role in {"sheet_id", "barcode"}
                or r.key in {"sheet_id", "barcode"}
                or getattr(r, "id", None) in {"sheet_id", "barcode"}
            ):
                return r
        return None

    @property
    def graded_rois(self) -> list[TextROI]:
        return [r for r in self.rois if r.graded]

    @property
    def sid_roi(self) -> TextROI | None:
        """Returns write-in Student ID ROI if student ID uses image number recognition."""
        for r in self.rois:
            if r.role == "student_id" or r.key == "sid":
                return r
        return None

    @property
    def name_roi(self) -> TextROI | None:
        """Returns student name ROI if present."""
        for r in self.rois:
            if (
                r.role == "name"
                or r.key == "name"
                or getattr(r, "id", None) == "name"
                or "name" in (getattr(r, "label", "") or "").lower()
            ):
                return r
        return None

    @property
    def score_roi(self) -> TextROI | None:
        """Returns dedicated Score box ROI if present."""
        for r in self.rois:
            if (
                r.role == "score"
                or r.key == "score"
                or getattr(r, "id", None) == "score"
                or "score" in (getattr(r, "label", "") or "").lower()
            ):
                return r
        return None

    @property
    def margin(self) -> float:
        return float(self.raw.get("content", {}).get("x", 12.0))

    def item_order(self) -> list[str]:
        """Gradable item keys in printed order (bubble questions then text regions by zone)."""
        keys: list[str] = []
        for z in self.zones:
            keys.extend(g.key for g in z.groups if g.kind != "sid")
            keys.extend(r.key for r in z.rois if r.graded)
        return keys

    def zone(self, zone_id: str) -> Zone:
        for z in self.zones:
            if z.id == zone_id:
                return z
        raise KeyError(zone_id)

    # ---- loading -----------------------------------------------------------
    @classmethod
    def load(cls, path: str | Path) -> "Layout":
        p = Path(path)
        if p.is_dir():
            direct = p / "layout.json"
            if direct.is_file():
                with open(direct, encoding="utf-8") as fh:
                    return cls.from_dict(json.load(fh))
            layouts = sorted(p.glob("*.layout.json")) or sorted(p.glob("*layout*.json"))
            if layouts:
                with open(layouts[0], encoding="utf-8") as fh:
                    return cls.from_dict(json.load(fh))
            raise FileNotFoundError(f"No layout.json found in exam package directory {p}")

        if p.suffix.lower() == ".zip" and p.is_file():
            import zipfile

            with zipfile.ZipFile(p, "r") as zf:
                names = zf.namelist()
                target = None
                for n in names:
                    if Path(n).name.lower() == "layout.json":
                        target = n
                        break
                if not target:
                    for n in names:
                        if "layout" in Path(n).name.lower() and n.endswith(".json"):
                            target = n
                            break
                if not target:
                    raise FileNotFoundError(f"No layout.json found in zip package {p}")
                with zf.open(target) as fh:
                    return cls.from_dict(json.load(fh))

        with open(p, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    @classmethod
    def from_dict(cls, data: dict) -> "Layout":
        if data.get("schema") != LAYOUT_SCHEMA:
            raise LayoutError(f"Unsupported layout schema {data.get('schema')!r}; expected {LAYOUT_SCHEMA!r}")
        if data.get("units", "mm") != "mm":
            raise LayoutError("Layout units must be millimetres")
        try:
            fiducials = tuple(
                Fiducial(
                    id=int(f["id"]),
                    corner=f["corner"],
                    size=float(f["size"]),
                    corners=tuple((float(x), float(y)) for x, y in f["corners"]),
                )
                for f in data["fiducials"]
            )
            zones = []
            for z in data["zones"]:
                groups = tuple(
                    BubbleGroup(
                        key=str(g["key"]),
                        kind=g["kind"],
                        label=str(g.get("label", g["key"])),
                        zone_id=z["id"],
                        index=g.get("index"),
                        options=tuple(Bubble(str(o["value"]), float(o["cx"]), float(o["cy"])) for o in g["options"]),
                    )
                    for g in z.get("groups", [])
                )
                rois = tuple(
                    TextROI(
                        id=r["id"],
                        key=str(r["key"]),
                        label=r.get("label", r["key"]),
                        zone_id=z["id"],
                        x=float(r["x"]),
                        y=float(r["y"]),
                        w=float(r["w"]),
                        h=float(r["h"]),
                        charset=r.get("charset", "any"),
                        multiline=bool(r.get("multiline", False)),
                        ocr=bool(r.get("ocr", True)),
                        graded=bool(r.get("graded", False)),
                        points=float(r.get("points", 0) or 0),
                        role=r.get("role"),
                        digits=int(r.get("digits", 0) or 0),
                    )
                    for r in z.get("rois", [])
                )
                b = z["bbox"]
                zones.append(Zone(z["id"], z["type"], z.get("label", ""), (b["x"], b["y"], b["w"], b["h"]), groups, rois))
            bubble = data["bubble"]
            layout = cls(
                template_id=data["templateId"],
                title=data.get("title", ""),
                paper=data["page"]["paper"],
                page_width=float(data["page"]["width"]),
                page_height=float(data["page"]["height"]),
                dictionary=data["fiducial"]["dictionary"],
                fiducials=fiducials,
                bubble_diameter=float(bubble["diameter"]),
                pitch_x=float(bubble["pitchX"]),
                pitch_y=float(bubble["pitchY"]),
                zones=tuple(zones),
                raw=data,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise LayoutError(f"Malformed layout file: {exc!r}") from exc
        if len(layout.fiducials) != 4:
            raise LayoutError("Layout must define exactly four fiducials")
        if not (50.0 <= layout.page_width <= 500.0 and 50.0 <= layout.page_height <= 500.0):
            raise LayoutError(f"Layout page dimensions out of valid bounds (50-500mm): {layout.page_width}x{layout.page_height}")
        return layout
