from shipcalc.money import format_cents


def test_format_cents_pads():
    assert format_cents(1205) == "$12.05"
