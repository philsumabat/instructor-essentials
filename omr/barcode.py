"""Zero-dependency Code 39 barcode decoder and OpenCV barcode integration."""

from typing import Any, Sequence
import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None  # type: ignore

CODE39_PATTERNS = {
    "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
    "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
    "8": "100100100", "9": "001100100", "A": "100001001", "B": "001001001",
    "C": "101001000", "D": "000011001", "E": "100011000", "F": "001011000",
    "G": "000001101", "H": "100001100", "I": "001001100", "J": "000011100",
    "K": "100000011", "L": "001000011", "M": "101000010", "N": "000010011",
    "O": "100010010", "P": "001010010", "Q": "000000111", "R": "100000110",
    "S": "001000110", "T": "000010110", "U": "110000001", "V": "011000001",
    "W": "111000000", "X": "010010001", "Y": "110010000", "Z": "011010000",
    "-": "010000101", ".": "110000100", " ": "011000100", "*": "010010100",
    "$": "010101000", "/": "010100010", "+": "010001010", "%": "000101010",
}
REV_CODE39 = {v: k for k, v in CODE39_PATTERNS.items()}


def decode_code39_scanline(binary_line: Sequence[int]) -> str | None:
    """Decodes a 1D binary scanline (1 for black, 0 for white)."""
    if len(binary_line) < 30:
        return None

    runs: list[tuple[int, int]] = []
    curr = 1 if binary_line[0] else 0
    count = 1
    for val in binary_line[1:]:
        b = 1 if val else 0
        if b == curr:
            count += 1
        else:
            runs.append((curr, count))
            curr = b
            count = 1
    runs.append((curr, count))

    # Strip quiet zones
    while runs and runs[0][0] == 0:
        runs.pop(0)
    while runs and runs[-1][0] == 0:
        runs.pop()

    if len(runs) < 9:
        return None

    for start_idx in range(len(runs) - 8):
        if runs[start_idx][0] != 1:
            continue
        window = runs[start_idx : start_idx + 9]
        if not all(window[k][0] == (k % 2 == 0) for k in range(9)):
            continue

        lengths = [r[1] for r in window]
        sorted_lens = sorted(lengths)
        n_est = sum(sorted_lens[:6]) / 6.0
        w_est = sum(sorted_lens[6:]) / 3.0

        if w_est < 1.35 * n_est or n_est < 0.5:
            continue
        thresh = (n_est + w_est) / 2.0

        start_pat = "".join("1" if l >= thresh else "0" for l in lengths)
        if start_pat != CODE39_PATTERNS["*"]:
            continue

        decoded: list[str] = []
        idx = start_idx + 9
        matched_stop = False

        while idx < len(runs):
            if idx < len(runs) and runs[idx][0] == 0:
                idx += 1
            if idx + 9 > len(runs):
                break

            char_window = runs[idx : idx + 9]
            if not all(char_window[k][0] == (k % 2 == 0) for k in range(9)):
                break

            char_lengths = [r[1] for r in char_window]
            char_pat = "".join("1" if l >= thresh else "0" for l in char_lengths)
            char_val = REV_CODE39.get(char_pat)
            if not char_val:
                break
            if char_val == "*":
                matched_stop = True
                break

            decoded.append(char_val)
            idx += 9

        if matched_stop and decoded:
            return "".join(decoded)

    return None


def decode_barcode_image(image: np.ndarray) -> str | None:
    """Decodes barcode from an image crop (BGR or Grayscale)."""
    if image is None or image.size == 0:
        return None

    # 1. Try OpenCV BarcodeDetector if available
    if cv2 is not None and hasattr(cv2, "barcode") and hasattr(cv2.barcode, "BarcodeDetector"):
        try:
            detector = cv2.barcode.BarcodeDetector()
            ret_val, decoded_info, decoded_type, _ = detector.detectAndDecode(image)
            if ret_val and decoded_info:
                val = decoded_info[0] if isinstance(decoded_info, (list, tuple)) else str(decoded_info)
                val = val.strip().strip("*")
                if val:
                    return val
        except Exception:
            pass

    # 2. Pure scanline raster decoder fallback
    gray = image
    if len(image.shape) == 3 and cv2 is not None:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    elif len(image.shape) == 3:
        gray = (0.299 * image[:, :, 2] + 0.587 * image[:, :, 1] + 0.114 * image[:, :, 0]).astype(np.uint8)

    h, w = gray.shape
    if w < 20 or h < 5:
        return None

    candidates: dict[str, int] = {}
    for s in range(5):
        y_frac = 0.25 + s * 0.125
        y = min(h - 1, max(0, int(h * y_frac)))
        row = gray[y, :]

        min_l = float(np.min(row))
        max_l = float(np.max(row))
        if max_l - min_l < 30:
            continue

        thresh = (min_l + max_l) * 0.5
        binary = (row < thresh).astype(np.uint8)

        decoded = decode_code39_scanline(binary.tolist())
        if decoded:
            candidates[decoded] = candidates.get(decoded, 0) + 1

    if candidates:
        return max(candidates.items(), key=lambda it: it[1])[0]

    return None
