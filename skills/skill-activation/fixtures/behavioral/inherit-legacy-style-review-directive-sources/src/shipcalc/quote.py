from shipcalc.errors import Overweight
from shipcalc.rates import PER_KG_CENTS, base_cents_for

MAX_WEIGHT_GRAMS = 30000


def quote_cents(zone, weight_grams):
    """Return the total shipping price in cents."""
    if weight_grams > MAX_WEIGHT_GRAMS:
        raise Overweight(weight_grams)
    return base_cents_for(zone) + _weight_cents(weight_grams)


def _weight_cents(weight_grams):
    whole_kg = -(-weight_grams // 1000)
    return whole_kg * PER_KG_CENTS
