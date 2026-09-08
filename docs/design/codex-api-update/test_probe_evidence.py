"""Negative controls applied to the actual recorded local protocol matrix."""
import copy
import json
from pathlib import Path
import unittest

from probe_evidence import evaluate, record_snapshot, scenario_events


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.result = json.loads(Path(__file__).with_name('evidence').joinpath('probe-results.json').read_text())

    def case(self, name):
        return next(c for c in self.result['cases'] if c['name'] == name)

    def test_record_is_detached_from_nested_mutation(self):
        events = [{'params': {'threadId': 'thread-a', 'turn': {'id': 'turn-a'}}}]
        cases = []
        record_snapshot(cases, 'first', events, 'thread-a')
        frozen = copy.deepcopy(cases)
        events[0]['params']['turn']['id'] = 'changed'
        events.append({'params': {'threadId': 'thread-b'}})
        self.assertEqual(cases, frozen)

    def test_scenario_boundary_excludes_previous_and_other_threads(self):
        events = [{'params': {'threadId': 'thread-a', 'n': 0}},
                  {'params': {'threadId': 'thread-b', 'n': 1}},
                  {'params': {'threadId': 'thread-a', 'n': 2}}]
        actual = scenario_events(events, 'thread-a', 1)
        self.assertEqual(actual, [events[2]])
        events[2]['params']['n'] = 3
        self.assertEqual(actual[0]['params']['n'], 2)

    def test_recorded_matrix_passes(self):
        self.assertTrue(all(evaluate(self.result).values()))

    def test_wrong_thread_cannot_prove_injection_persistence(self):
        rows = self.case('canonical_marker_records')['response']
        original = self.result['threads']['injection']
        for row in rows:
            if row['threadId'] == original:
                row['threadId'] = self.result['threads']['idle']
        self.assertFalse(evaluate(self.result)['original_thread_has_two_injections'])

    def test_missing_injection_row_fails_persistence(self):
        rows = self.case('canonical_marker_records')['response']
        victim = next(r for r in rows if r['threadId'] == self.result['threads']['injection']
                      and r['record'].get('payload', {}).get('id') == 'probe-context')
        rows.remove(victim)
        self.assertFalse(evaluate(self.result)['original_thread_has_two_injections'])

    def test_transcript_alias_must_agree_with_thread(self):
        for row in self.case('canonical_marker_records')['response']:
            row['transcript'] = 'wrong-rollout'
        self.assertFalse(evaluate(self.result)['second_thread_has_one_injection'])

    def test_wrong_thread_events_cannot_prove_dispatch(self):
        for key, event_case, expected in (
            ('cold', 'normal_cold_resume_events', 'cold_resume_dispatches_normal_queue'),
            ('idle', 'idle_queue_events', 'idle_add_dispatches_automatically'),
        ):
            with self.subTest(scenario=key):
                saved = copy.deepcopy(self.case(event_case)['response'])
                for event in self.case(event_case)['response']:
                    event['params']['threadId'] = 'wrong-thread'
                self.assertFalse(evaluate(self.result)[expected])
                self.case(event_case)['response'] = saved

    def test_empty_queue_without_turn_start_fails_dispatch(self):
        for event_case, expected in (
            ('normal_cold_resume_events', 'cold_resume_dispatches_normal_queue'),
            ('idle_queue_events', 'idle_add_dispatches_automatically'),
        ):
            with self.subTest(scenario=event_case):
                self.case(event_case)['response'] = [e for e in self.case(event_case)['response']
                                                     if e.get('method') != 'turn/started']
                self.assertFalse(evaluate(self.result)[expected])

    def test_missing_canonical_input_fails_dispatch(self):
        self.case('canonical_marker_records')['response'] = []
        checks = evaluate(self.result)
        self.assertFalse(checks['cold_resume_dispatches_normal_queue'])
        self.assertFalse(checks['idle_add_dispatches_automatically'])

    def test_wrong_persisted_turn_fails_dispatch(self):
        for row in self.case('canonical_marker_records')['response']:
            metadata = row['record'].get('payload', {}).get('internal_chat_message_metadata_passthrough')
            if metadata:
                metadata['turn_id'] = 'wrong-turn'
        self.assertFalse(evaluate(self.result)['cold_resume_dispatches_normal_queue'])
        self.assertFalse(evaluate(self.result)['idle_add_dispatches_automatically'])

    def test_wrong_client_id_and_payload_fail_dispatch(self):
        for field in ('clientId', 'content'):
            with self.subTest(field=field):
                saved = copy.deepcopy(self.case('idle_queue_events')['response'])
                for event in self.case('idle_queue_events')['response']:
                    item = event['params'].get('item')
                    if item:
                        item[field] = 'wrong-input'
                self.assertFalse(evaluate(self.result)['idle_add_dispatches_automatically'])
                self.case('idle_queue_events')['response'] = saved


if __name__ == '__main__':
    unittest.main()
