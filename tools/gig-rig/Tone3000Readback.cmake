# Include immediately after TONE3000's JUCE CPMAddPackage block.
# @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-6] [DES-UI] [2.8]
find_package(Python3 REQUIRED COMPONENTS Interpreter)
if(NOT DEFINED LIB_DIR)
    message(FATAL_ERROR "T3K_LV2_PATCH_GET: TONE3000 LIB_DIR is not defined")
endif()
execute_process(
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_LIST_DIR}/apply_tone3000_readback.py"
        --source "${LIB_DIR}/juce"
    RESULT_VARIABLE _t3k_readback_result
    OUTPUT_VARIABLE _t3k_readback_record
    ERROR_VARIABLE _t3k_readback_error
)
if(NOT _t3k_readback_result EQUAL 0)
    message(FATAL_ERROR "T3K_LV2_PATCH_GET: ${_t3k_readback_error}")
endif()
string(STRIP "${_t3k_readback_record}" _t3k_readback_record)
message(STATUS "T3K_LV2_PATCH_GET: ${_t3k_readback_record}")
