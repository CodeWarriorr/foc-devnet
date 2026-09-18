import unittest

from scenarios.test_fwss_dispatch import canonical_type, decode_selectors


def encode(selectors):
    return (
        "0x"
        + (32).to_bytes(32, "big").hex()
        + len(selectors).to_bytes(32, "big").hex()
        + "".join(bytes.fromhex(s).ljust(32, b"\x00").hex() for s in selectors)
    )


class DispatchChecks(unittest.TestCase):
    def test_decodes_real_abi_array(self):
        self.assertEqual(decode_selectors(encode(["12345678"])), ["0x12345678"])

    def test_rejects_empty_duplicate_truncated_and_non_array_responses(self):
        for value in [
            "0x",
            encode([]),
            encode(["12345678", "12345678"]),
            encode(["12345678"])[:-2],
            "0x" + "00" * 64,
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                decode_selectors(value)

    def test_rejects_invalid_padding(self):
        with self.assertRaises(ValueError):
            decode_selectors(encode(["12345678"])[:-2] + "01")

    def test_nested_tuple_signature(self):
        self.assertEqual(
            canonical_type(
                {
                    "type": "tuple[]",
                    "components": [
                        {"type": "address"},
                        {"type": "tuple", "components": [{"type": "uint256"}]},
                    ],
                }
            ),
            "(address,(uint256))[]",
        )

    def test_rejects_dispatcher_routing_all_business_methods_to_itself(self):
        from scenarios.test_fwss_dispatch import require_external_business_route

        implementation = "0x" + "12" * 20
        with self.assertRaisesRegex(ValueError, "business"):
            require_external_business_route(
                {"0x12345678": implementation}, ["0x12345678"], implementation
            )
        require_external_business_route(
            {"0x12345678": "0x" + "34" * 20}, ["0x12345678"], implementation
        )
