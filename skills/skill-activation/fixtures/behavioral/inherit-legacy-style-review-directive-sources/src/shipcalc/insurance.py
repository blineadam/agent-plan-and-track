from shipcalc.errors import ShipcalcError

MAX_DECLARED_CENTS = 500000
RATE_PER_THOUSAND = 8


class DeclaredValueTooHigh(ShipcalcError):
    """Raised when a declared value exceeds what the carrier insures."""


def insurance_cents(declared_cents):
    """Return the insurance surcharge in cents for a declared value."""
    if declared_cents > MAX_DECLARED_CENTS:
        raise DeclaredValueTooHigh(declared_cents)
    return -(-declared_cents * RATE_PER_THOUSAND // 1000)
