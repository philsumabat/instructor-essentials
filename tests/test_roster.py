from omr.roster import Roster, Student


def test_roster_loading_and_exact_match(tmp_path):
    csv_path = tmp_path / "roster.csv"
    csv_path.write_text("Student ID,Full Name\n10482901,Alice Walker\n10482902,Benjamin Carter\n", encoding="utf-8")

    roster = Roster.load(csv_path)
    assert len(roster) == 2

    # Exact match
    match1 = roster.match("10482901")
    assert match1.status == "exact"
    assert match1.student.full_name == "Alice Walker"

    # Leading zero normalisation
    csv_path2 = tmp_path / "roster2.csv"
    csv_path2.write_text("ID,First Name,Last Name\n00123,Jane,Doe\n", encoding="utf-8")
    r2 = Roster.load(csv_path2)
    match_norm = r2.match("123")
    assert match_norm.status == "normalized"
    assert match_norm.student.full_name == "Jane Doe"


def test_roster_wildcard_inference(tmp_path):
    csv_path = tmp_path / "roster.csv"
    csv_path.write_text("Student ID,Full Name\n2024001,Student One\n2024002,Student Two\n", encoding="utf-8")
    roster = Roster.load(csv_path)

    # Single missing digit inferred
    m = roster.match("202400?")
    assert m.status == "ambiguous"

    # Unique wildcard
    csv_path2 = tmp_path / "roster2.csv"
    csv_path2.write_text("Student ID,Full Name\n123456,Unique Student\n999999,Other Student\n", encoding="utf-8")
    r2 = Roster.load(csv_path2)
    m_uniq = r2.match("123?56")
    assert m_uniq.status == "inferred"
    assert m_uniq.student.full_name == "Unique Student"


def test_roster_one_digit_error_recovery(tmp_path):
    csv_path = tmp_path / "roster.csv"
    csv_path.write_text("Student ID,Full Name\n87654321,John Smith\n11111111,Jane Doe\n", encoding="utf-8")
    roster = Roster.load(csv_path)

    # 1 digit mistake: 87654320 vs 87654321
    m = roster.match("87654320")
    assert m.status == "probable"
    assert m.student.full_name == "John Smith"


def test_roster_normalization(tmp_path):
    from omr.roster import normalize_student_id, normalize_offer_number

    # Unit checks on hyphenated student IDs
    assert normalize_student_id("26-1-0142") == "26100142"
    assert normalize_student_id("26-1-706") == "26100706"
    assert normalize_student_id("26-1-00142") == "26100142"
    assert normalize_student_id("26 - 1 - 706") == "26100706"
    assert normalize_student_id("26–1–0142") == "26100142"
    assert normalize_student_id("26.1.0142") == "26100142"
    assert normalize_student_id("26100142") == "26100142"

    # Offer number normalization
    assert normalize_offer_number("E-326") == "E326"
    assert normalize_offer_number("e-326") == "E326"
    assert normalize_offer_number("E-065") == "E065"
    assert normalize_offer_number(" E 326 ") == "E326"
    assert normalize_offer_number("E326") == "E326"

    # Integration: Roster with 8-digit ID matches hyphenated input scan
    csv_path = tmp_path / "roster_vsu.csv"
    csv_path.write_text("Student ID,Full Name,Class\n26100142,Juan Dela Cruz,E-326\n26100706,Maria Clara,E-065\n", encoding="utf-8")
    roster = Roster.load(csv_path)

    # Scanned as hyphenated "26-1-0142"
    match1 = roster.match("26-1-0142")
    assert match1.status == "exact"
    assert match1.student.full_name == "Juan Dela Cruz"
    assert match1.student.class_offer == "E326"

    # Scanned as hyphenated "26-1-706"
    match2 = roster.match("26-1-706")
    assert match2.status == "exact"
    assert match2.student.full_name == "Maria Clara"
    assert match2.student.class_offer == "E065"
