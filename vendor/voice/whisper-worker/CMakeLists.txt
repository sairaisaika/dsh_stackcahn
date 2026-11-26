add_executable(sion-whisper-worker main.cpp)
include(DefaultTargetOptions)
target_link_libraries(sion-whisper-worker PRIVATE common whisper ${FFMPEG_LIBRARIES} ${CMAKE_THREAD_LIBS_INIT})
