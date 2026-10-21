import pytest

from shipcalc.errors import UnknownZone
from shipcalc.rates import base_cents_for


def test_unknown_zone_raises():
    with pytest.raises(UnknownZone):
        base_cents_for("orbital")
