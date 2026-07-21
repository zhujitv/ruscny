import 'dart:io' as io;
import 'dart:typed_data';

import 'package:web_socket/io_web_socket.dart';
import 'package:web_socket/web_socket.dart' as ws;

/// Creates the native WebSocket used by Socket.IO while preserving handshake
/// headers and making a peer-first close safe to repeat.
Future<ws.WebSocket> connectReliableWebSocket(
  Uri uri, {
  Iterable<String>? protocols,
  Map<String, String>? headers,
}) async {
  // Ownership is transferred to IOWebSocket and closed by Socket.IO.
  // ignore: close_sinks
  final io.WebSocket socket;
  try {
    socket = await io.WebSocket.connect(
      uri.toString(),
      protocols: protocols,
      headers: headers,
    );
  } on io.WebSocketException catch (error) {
    throw ws.WebSocketException(error.message);
  }
  return IdempotentCloseWebSocket(IOWebSocket.fromWebSocket(socket));
}

/// `package:web_socket` reports an error when close is called after the peer
/// has already closed. Socket.IO may legitimately repeat that close while it
/// destroys a server-disconnected transport, so only that expected condition
/// is absorbed. All other errors and all data operations remain unchanged.
final class IdempotentCloseWebSocket implements ws.WebSocket {
  IdempotentCloseWebSocket(this._inner);

  final ws.WebSocket _inner;
  Future<void>? _closeFuture;

  @override
  Stream<ws.WebSocketEvent> get events => _inner.events;

  @override
  String get protocol => _inner.protocol;

  @override
  void sendBytes(Uint8List bytes) => _inner.sendBytes(bytes);

  @override
  void sendText(String text) => _inner.sendText(text);

  @override
  Future<void> close([int? code, String? reason]) =>
      _closeFuture ??= _closeOnce(code, reason);

  Future<void> _closeOnce(int? code, String? reason) async {
    try {
      await _inner.close(code, reason);
    } on ws.WebSocketConnectionClosed {
      // The peer already completed the close handshake.
    }
  }
}
