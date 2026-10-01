package com.universalharness.node

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.json.JSONObject

class NdJsonFramerTest {
    @Test
    fun `frames split on newlines across arbitrary chunks`() {
        val framer = NdJsonFramer()
        assertEquals(emptyList(), framer.push("{\"a\":"))
        assertEquals(listOf("{\"a\":1}"), framer.push("1}\n"))
        assertEquals(listOf("{\"b\":2}", "{\"c\":3}"), framer.push("{\"b\":2}\n{\"c\":3}\n"))
    }

    @Test
    fun `blank lines are tolerated and CR is stripped`() {
        val framer = NdJsonFramer()
        assertEquals(listOf("", "{\"a\":1}"), framer.push("\r\n{\"a\":1}\r\n"))
    }

    @Test
    fun `an unterminated line exceeding the cap poisons the framer`() {
        val framer = NdJsonFramer(maxLineBytes = 100)
        framer.push("x".repeat(60))
        assertFailsWith<IllegalStateException> { framer.push("x".repeat(60)) }
        assertTrue(framer.corrupted)
        assertEquals(emptyList<String>(), framer.push("more"))
    }

    @Test
    fun `a complete frame larger than the cap is still delivered`() {
        // The cap defends against unbounded partial buffering; a newline-terminated frame
        // that fits is fine.
        val framer = NdJsonFramer(maxLineBytes = 1_000_000)
        val line = "x".repeat(500_000)
        assertEquals(listOf(line), framer.push("$line\n"))
    }
}

class DshSdkProtocolTest {
    @Test
    fun `initialize params carry cwd and optional model fields`() {
        val params = DshSdkProtocol.initializeParams("/workspace", "deepseek-official", "deepseek-chat")
        assertEquals("/workspace", params.getString("cwd"))
        assertEquals("deepseek-official", params.getString("provider"))
        assertEquals("deepseek-chat", params.getString("model"))
        assertEquals(3, params.length())
    }

    @Test
    fun `prompt params wrap text into one content block`() {
        val params = DshSdkProtocol.promptParams("sess_1", "hello")
        assertEquals("sess_1", params.getString("sessionId"))
        val block = params.getJSONArray("contentBlocks").getJSONObject(0)
        assertEquals("text", block.getString("type"))
        assertEquals("hello", block.getString("text"))
    }

    @Test
    fun `request frames are JSON-RPC 2_0 with numeric id`() {
        val frame = DshSdkProtocol.request("initialize", 7, DshSdkProtocol.initializeParams("/w"))
        assertEquals("2.0", frame.getString("jsonrpc"))
        assertEquals(7, frame.getInt("id"))
        assertEquals("initialize", frame.getString("method"))
        assertTrue(DshSdkProtocol.isResponse(frame.put("result", JSONObject()), 7))
        assertFalse(DshSdkProtocol.isResponse(frame, 8))
    }

    @Test
    fun `error responses are detected and their messages extracted`() {
        val frame = JSONObject().put("id", 1).put("error", JSONObject().put("message", "boom"))
        assertTrue(DshSdkProtocol.isErrorResponse(frame))
        assertEquals("boom", DshSdkProtocol.errorMessage(frame))
    }

    @Test
    fun `notifications are recognized and unknown methods are not`() {
        val frame = JSONObject().put("method", "session.event").put("params", JSONObject())
        assertEquals("session.event", DshSdkProtocol.notificationMethod(frame))
        assertNull(DshSdkProtocol.notificationMethod(JSONObject().put("method", "future.thing")))
    }

    @Test
    fun `parseLine tolerates non-protocol noise and blanks`() {
        assertNull(DshSdkProtocol.parseLine("proot error: can't chmod"))
        assertNull(DshSdkProtocol.parseLine("   "))
        assertEquals(1, DshSdkProtocol.parseLine("{\"id\":1}")!!.getInt("id"))
    }
}
