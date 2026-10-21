from shipcalc.quote import quote_cents


def test_quote_rounds_weight_up():
    assert quote_cents("local", 1001) == 450 + 2 * 120
