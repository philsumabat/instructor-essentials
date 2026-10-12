"""Optical Mark Recognition grading pipeline.

Modules
-------
layout      Load the resolved sheet geometry exported by the browser builder.
roster      CSV roster ingestion and OMR-ID → student matching.
vision      Fiducial detection, perspective registration, bubble reading.
ocr         Handwritten ROI extraction with pluggable OCR engines.
grading     Answer-key evaluation, annotated output, item analysis, reports.
pipeline    End-to-end batch orchestration.
"""

__version__ = "1.0.0"
