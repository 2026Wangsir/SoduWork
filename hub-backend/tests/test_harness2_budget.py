"""Seven-stage refinement bounds explicit truncation recovery and retains real usage."""
from __future__ import annotations

import importlib
import importlib.util
import json
import unittest

from app.services.harness2_errors import StructuredFailure, PlanningOutputLimit, failure_message
from app.services.harness2_budget import (
    MAX_PROMPT_BYTES, MAX_REPORTED_TOKENS, MAX_SECONDS, MAX_REQUEST_SECONDS,
    MAX_OUTPUT_TOKENS,
)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Harness2BudgetTests(unittest.TestCase):
    def setUp(self):
        name = "app.services.harness2_budget"
        self.assertIsNotNone(importlib.util.find_spec(name), "The refinement budget controller must exist")
        self.clock = Clock()
        self.budget = importlib.import_module(name).RefinementBudget(clock=self.clock)
        self.model = {"base": "https://fixture.invalid/v1", "key": "fixture-secret",
                      "model": "fixture", "maxOutputTokens": 65536}
        self.messages = [{"role": "user", "content": "private-task"}]
        self.requests = []
        self.usage = []

    def complete(self, model, messages, on_usage, *, timeout):
        self.requests.append((model, messages, timeout))
        on_usage({"input_tokens": 10, "output_tokens": 5})
        return "result"

    def run_request(self, complete=None, *, model=None, messages=None):
        return self.budget.run(
            self.model if model is None else model,
            self.messages if messages is None else messages,
            complete or self.complete, self.usage.append)

    def assert_budget_failure(self, operation):
        with self.assertRaises(StructuredFailure) as caught:
            operation()
        self.assertEqual(caught.exception.code, "refinement_budget")
        self.assertIn("预算", failure_message(caught.exception, "refine"))
        return caught.exception

    def test_seven_calls_are_allowed_but_eighth_is_rejected_before_transport(self):
        for _ in range(7):
            self.assertEqual(self.run_request(), "result")
        self.assert_budget_failure(self.run_request)
        self.assertEqual(len(self.requests), 7)
        self.assertEqual(len(self.usage), 7)

    def test_normal_seven_stage_turn_has_bounded_input_output_and_latency(self):
        self.assertEqual((MAX_PROMPT_BYTES, MAX_REPORTED_TOKENS, MAX_OUTPUT_TOKENS,
                          MAX_SECONDS, MAX_REQUEST_SECONDS), (128000, 128000, 8192, 420, 300))
        messages = [{"role": "user", "content": "Constraint and evidence.\n" * 2500}]
        delays = iter([25, 50, 50, 25, 25, 80, 25])
        outputs = iter([1200] * 7)

        def charged(model, messages, on_usage, *, timeout):
            self.assertEqual(model["maxOutputTokens"], 2048)
            delay = next(delays)
            self.assertGreaterEqual(timeout, delay)
            self.requests.append(timeout)
            self.clock.now += delay
            on_usage({"input_tokens": 11400, "output_tokens": next(outputs)})
            return "Complete plan or JSON proposal."

        for _ in range(7):
            self.run_request(charged, messages=messages)
        self.assertEqual(self.clock.now, 280)
        self.assertEqual(self.budget.reported_tokens, 88200)
        self.assertEqual(len(self.usage), 7)
        self.assert_budget_failure(self.run_request)
        self.assertEqual(len(self.requests), 7)

    def test_output_cap_preserves_smaller_user_limit_and_does_not_mutate_model(self):
        self.run_request()
        self.assertEqual(self.requests[-1][0]["maxOutputTokens"], 2048)
        self.assertEqual(self.model["maxOutputTokens"], 65536)
        self.run_request(model={**self.model, "maxOutputTokens": 512})
        self.assertEqual(self.requests[-1][0]["maxOutputTokens"], 512)
        self.run_request(model={key: value for key, value in self.model.items() if key != "maxOutputTokens"})
        self.assertEqual(self.requests[-1][0]["maxOutputTokens"], 2048)

    def test_transport_receives_request_limit_or_remaining_deadline(self):
        self.run_request()
        self.assertEqual(self.requests[-1][2], MAX_REQUEST_SECONDS)
        self.clock.now = MAX_SECONDS - 3.75
        self.run_request()
        self.assertEqual(self.requests[-1][2], 3.75)

    def test_expired_deadline_rejects_request_before_transport(self):
        self.clock.now = MAX_SECONDS
        self.assert_budget_failure(self.run_request)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.usage, [])

    def test_response_after_deadline_fails_but_keeps_reported_usage(self):
        def delayed(model, messages, on_usage, *, timeout):
            self.requests.append(timeout)
            self.clock.now = MAX_SECONDS
            on_usage({"input_tokens": 150, "output_tokens": 40})
            return "late result"
        self.assert_budget_failure(lambda: self.run_request(delayed))
        self.assertEqual(self.requests, [MAX_REQUEST_SECONDS])
        self.assertEqual(self.usage, [{"input_tokens": 150, "output_tokens": 40}])
        self.assert_budget_failure(self.run_request)
        self.assertEqual(len(self.requests), 1)

    def test_token_threshold_forwards_actual_usage_then_rejects_following_calls(self):
        amounts = [MAX_REPORTED_TOKENS - 1000, 1000]

        def charged(model, messages, on_usage, *, timeout):
            self.requests.append(timeout)
            on_usage({"input_tokens": amounts.pop(0), "output_tokens": 0})
            return "result"
        self.assertEqual(self.run_request(charged), "result")
        self.assert_budget_failure(lambda: self.run_request(charged))
        self.assertEqual([row["input_tokens"] for row in self.usage], [MAX_REPORTED_TOKENS - 1000, 1000])
        self.assertEqual(self.budget.reported_tokens, MAX_REPORTED_TOKENS)
        self.assert_budget_failure(self.run_request)
        self.assertEqual(len(self.requests), 2)

    def test_provider_can_report_more_than_remaining_tokens_and_none_are_hidden(self):
        def overspent(model, messages, on_usage, *, timeout):
            on_usage({"input": MAX_REPORTED_TOKENS + 3000, "output": 6000})
            return "result"
        self.assert_budget_failure(lambda: self.run_request(overspent))
        self.assertEqual(self.usage, [{"input": MAX_REPORTED_TOKENS + 3000, "output": 6000}])
        self.assertEqual(self.budget.reported_tokens, MAX_REPORTED_TOKENS + 9000)

    def test_multiple_usage_deltas_are_counted_without_counting_total_twice(self):
        def charged(model, messages, on_usage, *, timeout):
            on_usage({"input_tokens": 100, "output_tokens": 50, "total": 150})
            on_usage({"input": 200, "output": 75, "totalTokens": 275})
            return "result"
        self.assertEqual(self.run_request(charged), "result")
        self.assertEqual(self.budget.reported_tokens, 425)
        self.assertEqual(len(self.usage), 2)

    def test_exact_prompt_byte_limit_is_allowed_and_next_byte_is_rejected(self):
        empty = [{"role": "user", "content": ""}]
        overhead = len(json.dumps(empty, ensure_ascii=False).encode("utf-8"))
        allowed = [{"role": "user", "content": "x" * (MAX_PROMPT_BYTES - overhead)}]
        self.assertEqual(self.run_request(messages=allowed), "result")
        rejected = [{"role": "user", "content": allowed[0]["content"] + "x"}]
        self.assert_budget_failure(lambda: self.run_request(messages=rejected))
        self.assertEqual(len(self.requests), 1)

    def test_prompt_limit_counts_utf8_bytes_not_characters(self):
        messages = [{"role": "user", "content": "界" * (MAX_PROMPT_BYTES // 3)}]
        self.assertLess(len(json.dumps(messages, ensure_ascii=False)), MAX_PROMPT_BYTES)
        self.assert_budget_failure(lambda: self.run_request(messages=messages))
        self.assertEqual(self.requests, [])

    def test_transport_failure_is_not_retried_or_replaced_with_fallback(self):
        failure = TimeoutError("fixture-private-response")

        def failed(*_args, **_kwargs):
            self.requests.append("failed")
            raise failure
        with self.assertRaises(TimeoutError) as caught:
            self.run_request(failed)
        self.assertIs(caught.exception, failure)
        self.assertEqual(self.requests, ["failed"])
        self.assertEqual(self.usage, [])
        self.assert_budget_failure(self.run_request)
        self.assertEqual(self.requests, ["failed"])

    def test_one_recovery_counts_every_attempt_without_changing_seven_phase_limit(self):
        retries = []
        def truncated_once(model, messages, on_usage, *, timeout):
            self.complete(model, messages, on_usage, timeout=timeout)
            if len(self.requests) == 1:
                raise PlanningOutputLimit()
            return "complete"
        self.assertEqual(self.budget.run(self.model, self.messages, truncated_once,
                                        self.usage.append, on_retry=lambda: retries.append(True)), "complete")
        self.assertEqual([row[0]["maxOutputTokens"] for row in self.requests], [2048, 4096])
        self.assertEqual(self.requests[0][1], self.requests[1][1])
        self.assertEqual(retries, [True])
        for _ in range(6):
            self.run_request()
        self.assertEqual((self.budget.calls, self.budget.retries, len(self.requests)), (7, 1, 8))
        self.assertEqual((len(self.usage), self.budget.reported_tokens), (8, 120))
        self.assert_budget_failure(self.run_request)

    def test_recovery_preserves_smaller_model_cap_and_never_mutates_configuration(self):
        for limit, expected in [(512, [512]), (2048, [2048]), (3000, [2048, 3000])]:
            with self.subTest(limit=limit):
                self.setUp()
                original = {**self.model, "maxOutputTokens": limit}
                def truncated(model, messages, on_usage, *, timeout):
                    self.complete(model, messages, on_usage, timeout=timeout)
                    raise PlanningOutputLimit()
                with self.assertRaises(PlanningOutputLimit):
                    self.run_request(truncated, model=original)
                self.assertEqual([row[0]["maxOutputTokens"] for row in self.requests], expected)
                self.assertEqual(original["maxOutputTokens"], limit)
                self.assertEqual(len(self.usage), len(expected))
                self.assert_budget_failure(self.run_request)

    def test_always_on_reasoning_gets_at_most_one_bounded_recovery(self):
        messages = [{"role": "system", "content": "SODUWORK_HARNESS2_EDIT\nstage=inv1.a1"}]
        def truncated(model, messages, on_usage, *, timeout):
            self.complete(model, messages, on_usage, timeout=timeout)
            raise PlanningOutputLimit()
        with self.assertRaises(PlanningOutputLimit):
            self.run_request(truncated, model={**self.model, "reasoning": True}, messages=messages)
        self.assertEqual([row[0]["maxOutputTokens"] for row in self.requests], [8192, 16384])
        self.assertEqual(self.budget.retries, 1)
        self.assert_budget_failure(self.run_request)

    def test_successful_recovery_headroom_is_reused_only_for_same_phase_kind(self):
        proposals = [{"role": "system", "content": "SODUWORK_HARNESS2_EDIT\nstage=inv1.a1"}]
        def truncate_initial(model, messages, on_usage, *, timeout):
            self.complete(model, messages, on_usage, timeout=timeout)
            if model["maxOutputTokens"] < 8192:
                raise PlanningOutputLimit()
            return "complete"
        self.assertEqual(self.run_request(truncate_initial, messages=proposals), "complete")
        self.assertEqual(self.run_request(truncate_initial, messages=proposals), "complete")
        self.run_request(messages=proposals, model={**self.model, "maxOutputTokens": 5000})
        self.run_request()
        self.assertEqual([row[0]["maxOutputTokens"] for row in self.requests], [4096, 8192, 8192, 5000, 2048])
        self.assertEqual(self.budget.retries, 1)

    def test_second_phase_cannot_spend_another_recovery(self):
        def truncated_once(model, messages, on_usage, *, timeout):
            self.complete(model, messages, on_usage, timeout=timeout)
            if len(self.requests) != 2:
                raise PlanningOutputLimit()
            return "complete"
        self.assertEqual(self.run_request(truncated_once), "complete")
        with self.assertRaises(PlanningOutputLimit):
            self.run_request(truncated_once)
        self.assertEqual((self.budget.calls, self.budget.retries, len(self.requests)), (2, 1, 3))
        self.assert_budget_failure(self.run_request)

    def test_retry_checks_remaining_time_and_usage_without_masking_token_limit(self):
        for elapsed, tokens in [(MAX_SECONDS, 15), (0, MAX_REPORTED_TOKENS)]:
            with self.subTest(elapsed=elapsed, tokens=tokens):
                self.setUp()
                def truncated(*args, **kwargs):
                    self.requests.append(True)
                    self.clock.now = elapsed
                    args[2]({"input_tokens": tokens, "output_tokens": 0})
                    raise PlanningOutputLimit()
                with self.assertRaises(PlanningOutputLimit):
                    self.run_request(truncated)
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(self.budget.reported_tokens, tokens)
                self.assert_budget_failure(self.run_request)

    def test_retry_recomputes_deadline_and_progress_cancellation_blocks_transport(self):
        def truncated(model, messages, on_usage, *, timeout):
            self.complete(model, messages, on_usage, timeout=timeout)
            if len(self.requests) == 1:
                self.clock.now = MAX_SECONDS - 2
                raise PlanningOutputLimit()
            return "complete"
        self.assertEqual(self.run_request(truncated), "complete")
        self.assertEqual(self.requests[1][2], 2)
        self.setUp()
        def cancelled():
            raise RuntimeError("cancelled")
        with self.assertRaises(RuntimeError):
            self.budget.run(self.model, self.messages, truncated, on_retry=cancelled)
        self.assertEqual(len(self.requests), 1)
        self.assert_budget_failure(self.run_request)

    def test_controller_state_and_budget_error_never_retain_model_or_prompt(self):
        self.run_request()
        self.clock.now = MAX_SECONDS
        failure = self.assert_budget_failure(self.run_request)
        state = repr(vars(self.budget)) + str(failure)
        for private in ("fixture-secret", "fixture.invalid", "private-task"):
            self.assertNotIn(private, state)
        self.assertEqual(self.budget.calls, 1)


if __name__ == "__main__":
    unittest.main()
