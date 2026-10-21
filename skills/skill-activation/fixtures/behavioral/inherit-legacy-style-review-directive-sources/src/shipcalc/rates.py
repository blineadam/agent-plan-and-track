from shipcalc.errors import UnknownZone

ZONE_BASE_CENTS = {"local": 450, "regional": 790, "national": 1250}
PER_KG_CENTS = 120


def base_cents_for(zone):
    """Return the base price in cents for a destination zone."""
    try:
        return ZONE_BASE_CENTS[zone]
    except KeyError:
        raise UnknownZone(zone) from None
