import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/validation.dart';

void main() {
  test(
      'email validation rejects malformed addresses accepted by a contains check',
      () {
    expect(isValidEmail('user@example.com'), isTrue);
    expect(isValidEmail(' user@example.com '), isTrue);
    expect(isValidEmail('user@'), isFalse);
    expect(isValidEmail('user@@example.com'), isFalse);
    expect(isValidEmail('user＠example.com'), isFalse);
    expect(isValidEmail('user@example'), isFalse);
  });
}
