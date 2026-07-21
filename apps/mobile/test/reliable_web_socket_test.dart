import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/realtime/reliable_web_socket.dart';
import 'package:web_socket/web_socket.dart' as ws;

void main() {
  test('close absorbs a peer-first close and is repeatable', () async {
    final inner = _FakeWebSocket(
      closeError: ws.WebSocketConnectionClosed(),
    );
    final socket = IdempotentCloseWebSocket(inner);

    await socket.close();
    await socket.close();

    expect(inner.closeCalls, 1);
  });

  test('concurrent close calls share the same completion', () async {
    final closeCompleter = Completer<void>();
    final inner = _FakeWebSocket(closeCompleter: closeCompleter);
    final socket = IdempotentCloseWebSocket(inner);

    final first = socket.close(1000, 'done');
    final second = socket.close(1000, 'done');
    expect(identical(first, second), isTrue);

    closeCompleter.complete();
    await Future.wait([first, second]);
    expect(inner.closeCalls, 1);
  });

  test('close preserves unexpected WebSocket errors', () async {
    final inner = _FakeWebSocket(
      closeError: ws.WebSocketException('boom'),
    );
    final socket = IdempotentCloseWebSocket(inner);

    await expectLater(
      socket.close(),
      throwsA(
        isA<ws.WebSocketException>()
            .having((error) => error.message, 'message', 'boom'),
      ),
    );
  });

  test('data, events, and protocol are delegated unchanged', () async {
    final inner = _FakeWebSocket(protocol: 'socket.io');
    final socket = IdempotentCloseWebSocket(inner);
    final eventFuture = socket.events.first;

    socket.sendText('hello');
    socket.sendBytes(Uint8List.fromList([1, 2, 3]));
    inner.add(ws.TextDataReceived('event'));

    expect(socket.protocol, 'socket.io');
    expect(inner.sentText, ['hello']);
    expect(inner.sentBytes.single, [1, 2, 3]);
    expect(await eventFuture, ws.TextDataReceived('event'));
    await inner.dispose();
  });
}

final class _FakeWebSocket implements ws.WebSocket {
  _FakeWebSocket({
    this.protocol = '',
    this.closeError,
    this.closeCompleter,
  });

  final StreamController<ws.WebSocketEvent> _events =
      StreamController<ws.WebSocketEvent>.broadcast();
  final Object? closeError;
  final Completer<void>? closeCompleter;
  final List<String> sentText = [];
  final List<Uint8List> sentBytes = [];
  int closeCalls = 0;

  @override
  final String protocol;

  @override
  Stream<ws.WebSocketEvent> get events => _events.stream;

  void add(ws.WebSocketEvent event) => _events.add(event);

  Future<void> dispose() => _events.close();

  @override
  Future<void> close([int? code, String? reason]) async {
    closeCalls += 1;
    final error = closeError;
    if (error != null) throw error;
    await closeCompleter?.future;
  }

  @override
  void sendBytes(Uint8List bytes) => sentBytes.add(bytes);

  @override
  void sendText(String text) => sentText.add(text);
}
