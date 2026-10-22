from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from omr.annotator import ExamAnnotator


@pytest.fixture
def mock_layout():
    return MagicMock()


def test_annotator_save_creates_file(mock_layout, tmp_path):
    annotator = ExamAnnotator(mock_layout, px_per_mm=10.0)

    # Create a dummy image (e.g., 100x100 white image)
    dummy_image = np.full((100, 100, 3), 255, dtype=np.uint8)

    # Use a string path within tmp_path
    save_path_str = str(tmp_path / "test_output.jpg")

    returned_path = annotator.save(dummy_image, save_path_str)

    assert isinstance(returned_path, Path)
    assert returned_path == Path(save_path_str)
    assert returned_path.exists()
    assert returned_path.is_file()


def test_annotator_save_with_path_object(mock_layout, tmp_path):
    annotator = ExamAnnotator(mock_layout, px_per_mm=10.0)
    dummy_image = np.zeros((50, 50, 3), dtype=np.uint8)

    # Use a Path object
    save_path = tmp_path / "test_output_2.jpg"

    returned_path = annotator.save(dummy_image, save_path)

    assert returned_path == save_path
    assert returned_path.exists()


def test_annotator_save_creates_missing_directories(mock_layout, tmp_path):
    annotator = ExamAnnotator(mock_layout, px_per_mm=10.0)
    dummy_image = np.zeros((10, 10, 3), dtype=np.uint8)

    # Specify a path in a nested directory that doesn't exist yet
    nested_path = tmp_path / "new_dir" / "nested_dir" / "test_output.jpg"

    returned_path = annotator.save(dummy_image, nested_path)

    assert returned_path == nested_path
    assert returned_path.exists()
    assert (tmp_path / "new_dir" / "nested_dir").exists()
    assert (tmp_path / "new_dir" / "nested_dir").is_dir()
