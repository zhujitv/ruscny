import 'dart:async';

import 'package:just_audio/just_audio.dart';

final class AudioPlaybackQueue {
  AudioPlaybackQueue({
    AudioPlayer? player,
    Future<String?> Function()? accessToken,
  })  : _player = player ?? AudioPlayer(useProxyForRequestHeaders: false),
        _accessToken = accessToken;

  final AudioPlayer _player;
  final Future<String?> Function()? _accessToken;
  Future<void> _tail = Future.value();
  double _speed = 1;
  int _generation = 0;
  bool _disposed = false;

  Stream<PlayerState> get state => _player.playerStateStream;

  Future<void> setSpeed(double value) async {
    _speed = value.clamp(.5, 2).toDouble();
    await _player.setSpeed(_speed);
  }

  void enqueue(String url) {
    if (_disposed || url.isEmpty) return;
    final generation = _generation;
    _tail = _tail.catchError((_) {}).then((_) async {
      if (!_disposed && generation == _generation) {
        await _play(url, generation);
      }
    });
  }

  Future<void> playNow(String url) async {
    if (_disposed || url.isEmpty) return;
    await stop();
    if (_disposed) return;
    final generation = _generation;
    await _play(url, generation);
  }

  /// Stops the active item and invalidates every item waiting in the old
  /// queue. This is also used when the authenticated user leaves the app.
  Future<void> stop() async {
    if (_disposed) return;
    _generation += 1;
    _tail = Future.value();
    await _player.stop();
  }

  Future<void> _play(String url, int generation) async {
    if (_disposed || generation != _generation) return;
    await _player.setSpeed(_speed);
    if (_disposed || generation != _generation) return;
    final token = await _accessToken?.call();
    if (_disposed || generation != _generation) return;
    await _player.setUrl(
      url,
      headers:
          token?.isNotEmpty == true ? {'Authorization': 'Bearer $token'} : null,
    );
    // stop() can finish while setUrl is still resolving. In that race the old
    // setUrl may make the stale item playable again, so stop it a second time
    // before returning to the caller.
    if (_disposed || generation != _generation) {
      if (!_disposed) await _player.stop();
      return;
    }
    await _player.play();
    if (!_disposed && generation != _generation) await _player.stop();
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _generation += 1;
    await _player.dispose();
  }
}
