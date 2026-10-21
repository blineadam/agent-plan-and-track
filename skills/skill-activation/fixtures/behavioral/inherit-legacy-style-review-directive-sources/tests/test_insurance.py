from shipcalc.insurance import insurance_cents


def test_insurance_rounds_up():
    assert insurance_cents(10001) == 81
