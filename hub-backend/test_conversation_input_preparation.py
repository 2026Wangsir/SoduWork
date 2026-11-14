import unittest
from fastapi import HTTPException
from app.services.cloud_conversations import clean_options

class ConversationInputPreparationTests(unittest.TestCase):
    def test_empty_user_text_with_files_keeps_real_text_distinct(self):
        value = clean_options({
            'sessionId': 'cloud-1', 'agentId': 'pi', 'model': 'm', 'title': '', 'text': '',
            'inputPreparation': {'schemaVersion': 1, 'userText': '', 'fallback': True},
        }, has_files=True)
        self.assertEqual(value['userText'], '')
        self.assertEqual(value['inputPreparation']['schemaVersion'], 1)

    def test_empty_user_text_without_files_is_rejected(self):
        with self.assertRaises(HTTPException):
            clean_options({'sessionId': 'cloud-1', 'agentId': 'pi', 'model': 'm', 'title': '', 'text': ''}, has_files=False)

    def test_unknown_preparation_fields_are_rejected(self):
        with self.assertRaises(HTTPException):
            clean_options({'sessionId': 'cloud-1', 'agentId': 'pi', 'model': 'm', 'title': '', 'text': 'x',
                           'inputPreparation': {'prompt': 'untrusted'}} , has_files=False)

    def test_local_model_references_are_rejected_before_cloud_dispatch(self):
        for model in ('local:private:model', 'image::private::local:private:model',
                      'image::device:provider::local:private:model'):
            with self.subTest(model=model), self.assertRaisesRegex(
                    HTTPException, '本地模型只能在本机使用'):
                clean_options({'sessionId': 'cloud-1', 'agentId': 'pi', 'model': model,
                               'title': '', 'text': 'x'}, has_files=False)

if __name__ == '__main__':
    unittest.main()
