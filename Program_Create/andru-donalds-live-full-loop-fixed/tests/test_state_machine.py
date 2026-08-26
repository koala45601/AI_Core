import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from state_machine import choose_seat_indices, classify_snapshot, next_action, verified_payment_handoff


class TicketStateMachineTests(unittest.TestCase):
    def state(self, body, url="https://tickets.test/event", retry=None, status=None, controls=None, seat_controls=0):
        return classify_snapshot({"body": body, "url": url, "title": "Fixture", "retry_after_seconds": retry, "http_status": status, "actionable_controls": controls or [], "seat_control_count": seat_controls})

    def test_pre_sale(self):
        self.assertEqual(self.state("COMING SOON เปิดขายเร็ว ๆ นี้")["state"], "pre_sale")

    def test_queue_countdown_copy_is_pre_sale_without_join_control(self):
        self.assertEqual(self.state("นับถอยหลังเวลารับคิวซื้อบัตร")["state"], "pre_sale")

    def test_access_denied_is_reported_explicitly(self):
        result = self.state("Access Denied You don't have permission to access this page", status=403)
        self.assertEqual(result["state"], "access_denied")
        self.assertEqual(next_action(result), "show_server_denial_and_wait_for_user")

    def test_sale_within_thirty_minutes_is_armed(self):
        result = classify_snapshot(
            {"body": "COMING SOON", "url": "https://tickets.test/event", "title": "Fixture"},
            now=datetime(2026, 8, 24, 2, 35, tzinfo=timezone.utc),
            sale_open_at="2026-08-24T10:00:00+07:00",
        )
        self.assertEqual(result["state"], "armed_pre_sale")
        self.assertEqual(next_action(result), "hold_same_session_and_count_down")

    def test_sale_more_than_thirty_minutes_away_is_not_armed(self):
        result = classify_snapshot(
            {"body": "COMING SOON", "url": "https://tickets.test/event", "title": "Fixture"},
            now=datetime(2026, 8, 24, 1, 0, tzinfo=timezone.utc),
            sale_open_at="2026-08-24T10:00:00+07:00",
        )
        self.assertEqual(result["state"], "pre_sale")

    def test_sale_entry(self):
        self.assertEqual(self.state("รายละเอียดการซื้อบัตร", controls=["Buy Now ซื้อบัตร"])["state"], "sale_entry")

    def test_round_and_ticket_type_control_is_sale_entry(self):
        result = self.state("ON SALE NOW", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "sale_entry")
        self.assertEqual(next_action(result), "activate_verified_purchase_control")

    def test_visible_sale_entry_wins_over_generic_terms_copy(self):
        result = self.state("ON SALE NOW conditions เงื่อนไขข้อตกลง", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "sale_entry")

    def test_round_section_control_does_not_skip_pre_sale_queue_window(self):
        result = self.state("COMING SOON เปิดขายวันพรุ่งนี้", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "pre_sale")

    def test_purchase_instructions_without_visible_control_are_not_sale_entry(self):
        result = self.state("คลิกปุ่มซื้อบัตรในวันเปิดจำหน่าย")
        self.assertNotEqual(result["state"], "sale_entry")

    def test_queue_preserves_retry_after(self):
        result = self.state("You are in the buying queue. Status last updated", retry=17)
        self.assertEqual(result["state"], "queue")
        self.assertEqual(result["retry_after_seconds"], 17)
        self.assertEqual(next_action(result), "keep_same_session_and_wait_retry_after")

    def test_waiting_room_entry_is_not_active_queue(self):
        result = self.state("YOU ARE NOW IN THE ENTRY ZONE", controls=["Join waiting room"])
        self.assertEqual(result["state"], "waiting_room_entry")
        self.assertEqual(next_action(result), "join_waiting_room_once")

    def test_waiting_room_instructions_without_visible_control_are_not_entry(self):
        result = self.state("โปรดกดรอรับคิวซื้อบัตร 1 ชั่วโมงก่อนเปิดจำหน่าย")
        self.assertNotEqual(result["state"], "waiting_room_entry")

    def test_generic_waiting_room_copy_is_not_an_active_queue(self):
        result = self.state("Waiting room instructions: do not refresh this page")
        self.assertNotEqual(result["state"], "queue")

    def test_queue_position_requires_explicit_number(self):
        unknown = self.state("You are in the buying queue. Status last updated")
        numbered = self.state("You are in the buying queue. Queue position: 100")
        self.assertIsNone(unknown["queue_position"])
        self.assertFalse(unknown["queue_position_verified"])
        self.assertEqual(numbered["queue_position"], 100)
        self.assertTrue(numbered["queue_position_verified"])

    def test_server_outage_preserves_retry_after(self):
        result = self.state("Service unavailable", retry=12, status=503)
        self.assertEqual(result["state"], "server_unavailable")
        self.assertEqual(result["retry_after_seconds"], 12)
        self.assertEqual(next_action(result), "keep_same_session_and_wait_retry_after")

    def test_login_can_use_secure_credentials(self):
        result = self.state("เข้าสู่ระบบ รหัสผ่าน", url="https://event.example/user/signin.php")
        self.assertEqual(result["state"], "login")
        self.assertEqual(next_action(result), "fill_credentials_or_prompt_securely")

    def test_captcha_handoff(self):
        self.assertEqual(self.state("reCAPTCHA")["state"], "captcha_handoff")

    def test_captcha_before_waiting_room_wins_over_queue_control(self):
        result = self.state("Security check CAPTCHA YOU ARE NOW IN THE ENTRY ZONE", controls=["Join waiting room"])
        self.assertEqual(result["state"], "captcha_handoff")
        self.assertEqual(next_action(result), "user_handoff")

    def test_captcha_inside_active_queue_wins_over_queue_marker(self):
        result = self.state("You are in the buying queue. Verify you are human")
        self.assertEqual(result["state"], "captcha_handoff")

    def test_captcha_after_queue_transition_wins_over_challenge_http_status(self):
        for status in (403, 429, 503):
            with self.subTest(status=status):
                result = self.state("hCaptcha security check", status=status)
                self.assertEqual(result["state"], "captcha_handoff")

    def test_otp_handoff(self):
        self.assertEqual(self.state("OTP รหัสยืนยัน")["state"], "otp_handoff")

    def test_reserved_selection(self):
        self.assertEqual(self.state("Seat map เลือกที่นั่ง", seat_controls=12)["state"], "ticket_selection")

    def test_fixed_page_is_reserved_selection_even_without_standard_seat_attributes(self):
        result = self.state("ขั้นตอนที่ 2/4 เลือกที่นั่ง ยืนยันที่นั่ง", url="https://booking.test/fixed.php?zone=A3")
        self.assertEqual(result["state"], "ticket_selection")

    def test_instructional_seat_text_is_not_a_selection_page(self):
        self.assertNotEqual(self.state("อ่านข้อมูลผังที่นั่งและวิธีเลือกที่นั่ง จำนวนบัตร")["state"], "ticket_selection")

    def test_general_admission_selection(self):
        self.assertEqual(self.state("ขั้นตอนที่ 2/4 เลือกจำนวนบัตร General Admission", url="https://tickets.test/festival.php")["state"], "quantity_selection")

    def test_multiple_ticket_selection_state(self):
        checkpoint = self.state("Seat map เลือกที่นั่ง จำนวนบัตร 4", seat_controls=20)
        self.assertEqual(checkpoint["state"], "ticket_selection")

    def test_terms_page_is_not_mistaken_for_payment(self):
        checkpoint = self.state("เงื่อนไข ข้อตกลง Payment Methods QR PromptPay I accept the Terms", url="https://booking.test/verify_condition.php?query=927")
        self.assertEqual(checkpoint["state"], "terms_conditions")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_zone_and_attendee_states_follow_real_paths(self):
        self.assertEqual(self.state("ขั้นตอนที่ 1/4 เลือกรอบ & โซนการแสดง", url="https://booking.test/zones.php?query=927")["state"], "zone_selection")
        self.assertEqual(self.state("กรุณากรอกรายละเอียด ชื่อ-นามสกุลบน Ticket", url="https://booking.test/enroll.php?k=test")["state"], "attendee_details")

    def test_payment_options_are_not_final_payment(self):
        checkpoint = self.state("ขั้นตอนที่ 3/4 เลือกวิธีการชำระเงิน QR", url="https://booking.test/paymentall.php?k=test")
        self.assertEqual(checkpoint["state"], "checkout_options")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_server_close_sale_is_terminal(self):
        checkpoint = self.state("ขณะนี้ปิดจำหน่ายบัตรผ่านช่องทางออนไลน์", url="https://tickets.test/close-sale/?t=1")
        self.assertEqual(checkpoint["state"], "sale_closed")
        self.assertEqual(next_action(checkpoint), "stop_and_report_sale_closed")

    def test_explicit_ticket_status_sold_out_is_terminal(self):
        checkpoint = self.state("Ticket Status SOLD OUT")
        self.assertEqual(checkpoint["state"], "sold_out")
        self.assertEqual(next_action(checkpoint), "stop_and_report_sold_out")

    def test_marketing_sentence_does_not_fake_sold_out_status(self):
        checkpoint = self.state("The artist sold out many shows last year")
        self.assertNotEqual(checkpoint["state"], "sold_out")

    def test_adjacent_seats_require_consecutive_numbers(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R1", "number": "2"},
            {"zone": "A", "row": "R1", "number": "4"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "adjacent", ["A"]), [0, 1])
        self.assertEqual(choose_seat_indices(seats, 3, "adjacent", ["A"]), [])

    def test_same_zone_can_be_non_adjacent(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R2", "number": "9"},
            {"zone": "B", "row": "R1", "number": "2"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "same_zone", ["A"]), [0, 1])

    def test_any_seat_respects_zone_priority(self):
        seats = [
            {"zone": "B", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R1", "number": "7"},
            {"zone": "A", "row": "R3", "number": "20"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "any", ["A", "B"]), [1, 2])

    def test_any_seat_never_mixes_zones(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "B", "row": "R1", "number": "2"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "any", ["A", "B"]), [])

    def test_exact_row_and_seat_number(self):
        seats = [
            {"zone": "A", "row": "J", "number": "10"},
            {"zone": "A", "row": "K", "number": "10"},
            {"zone": "A", "row": "K", "number": "11"},
        ]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "exact"), [1])

    def test_nearest_number_stays_in_requested_zone(self):
        seats = [
            {"zone": "B", "row": "K", "number": "10"},
            {"zone": "A", "row": "K", "number": "8"},
            {"zone": "A", "row": "K", "number": "11"},
        ]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "nearest"), [2])

    def test_requested_zone_is_never_silently_changed(self):
        seats = [{"zone": "B", "row": "K", "number": "10"}]
        self.assertEqual(choose_seat_indices(seats, 1, "any", ["A"], [], [], "zone_any"), [])

    def test_exact_mode_fails_when_requested_seat_is_missing(self):
        seats = [{"zone": "A", "row": "K", "number": "11"}]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "exact"), [])

    def test_payment_is_verified_only_with_evidence(self):
        checkpoint = self.state("ขั้นตอนที่ 4/4 ชำระเงิน หมายเลขการสั่งซื้อ 2529889 PromptPay Remaining time: 590", url="https://booking.test/payment_kbankqr.php")
        self.assertEqual(checkpoint["state"], "payment_handoff")
        self.assertTrue(verified_payment_handoff(checkpoint))

    def test_generic_qr_copy_is_not_verified_checkout(self):
        checkpoint = self.state("Payment Methods include QR and PromptPay", url="https://tickets.test/conditions")
        self.assertNotEqual(checkpoint["state"], "payment_handoff")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_unknown_is_never_checkout(self):
        checkpoint = self.state("หน้าแรกทั่วไป")
        self.assertEqual(checkpoint["state"], "unknown")
        self.assertFalse(verified_payment_handoff(checkpoint))


if __name__ == "__main__":
    unittest.main(verbosity=2)
