import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Provider, useDispatch, useSelector } from 'react-redux'

import {
  addNote,
  deleteNote,
  resetNotes,
  storageApi,
  store,
  toggleTheme,
} from './src/store'
import type { RootState } from './src/store'

function NotesScreen() {
  const dispatch = useDispatch()
  const items = useSelector((state: RootState) => state.notes.items)
  const theme = useSelector((state: RootState) => state.notes.theme)
  const [draft, setDraft] = useState('')
  const dark = theme === 'dark'

  return (
    <View
      style={[styles.screen, dark ? styles.screenDark : styles.screenLight]}
      testID="notes-screen"
    >
      <Text style={[styles.title, dark && styles.textLight]}>Field Notes</Text>
      <Text
        testID="theme-value"
        style={dark ? styles.textLight : styles.textDark}
      >
        {theme}
      </Text>
      <TextInput
        testID="note-input"
        value={draft}
        onChangeText={setDraft}
        placeholder="Write a note"
        placeholderTextColor={dark ? '#94a3b8' : '#64748b'}
        style={[styles.input, dark && styles.inputDark]}
      />
      <Pressable
        testID="add-note"
        accessibilityRole="button"
        style={styles.primary}
        onPress={() => {
          dispatch(addNote(draft))
          setDraft('')
        }}
      >
        <Text style={styles.primaryLabel}>Add note</Text>
      </Pressable>
      <Pressable
        testID="theme-toggle"
        accessibilityRole="button"
        style={styles.secondary}
        onPress={() => dispatch(toggleTheme())}
      >
        <Text style={styles.secondaryLabel}>Toggle theme</Text>
      </Pressable>
      <Pressable
        testID="clear-storage"
        accessibilityRole="button"
        style={styles.danger}
        onPress={() => {
          storageApi.clearStorage()
          dispatch(resetNotes())
        }}
      >
        <Text style={styles.primaryLabel}>Clear saved notes</Text>
      </Pressable>
      <Text
        testID="note-count"
        style={dark ? styles.textLight : styles.textDark}
      >
        {items.length}
      </Text>
      {items.length === 0 ? (
        <Text
          testID="empty-notes"
          style={dark ? styles.textLight : styles.textDark}
        >
          No notes yet
        </Text>
      ) : (
        items.map((note) => (
          <View key={note.id} style={styles.row} testID="note-row">
            <Text
              testID="note-text"
              style={dark ? styles.textLight : styles.textDark}
            >
              {note.text}
            </Text>
            <Pressable
              testID="delete-note"
              accessibilityRole="button"
              onPress={() => dispatch(deleteNote(note.id))}
            >
              <Text style={styles.deleteLabel}>Delete</Text>
            </Pressable>
          </View>
        ))
      )}
      <StatusBar style={dark ? 'light' : 'dark'} />
    </View>
  )
}

export default function App() {
  const [ready, setReady] = useState(storageApi.hasHydrated())

  useEffect(() => {
    return storageApi.onFinishHydration(() => {
      setReady(true)
    })
  }, [])

  if (!ready) {
    return (
      <View style={styles.screen} testID="hydration-gate">
        <Text>Restoring notes…</Text>
      </View>
    )
  }

  return (
    <Provider store={store}>
      <NotesScreen />
    </Provider>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 24,
    gap: 12,
  },
  screenLight: {
    backgroundColor: '#f8fafc',
  },
  screenDark: {
    backgroundColor: '#0f172a',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  textDark: {
    color: '#0f172a',
  },
  textLight: {
    color: '#f8fafc',
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 12,
    color: '#0f172a',
    backgroundColor: '#fff',
  },
  inputDark: {
    borderColor: '#334155',
    color: '#f8fafc',
    backgroundColor: '#1e293b',
  },
  primary: {
    backgroundColor: '#0f766e',
    borderRadius: 8,
    padding: 12,
  },
  primaryLabel: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: '600',
  },
  secondary: {
    borderWidth: 1,
    borderColor: '#0f766e',
    borderRadius: 8,
    padding: 12,
  },
  secondaryLabel: {
    color: '#0f766e',
    textAlign: 'center',
    fontWeight: '600',
  },
  danger: {
    backgroundColor: '#b91c1c',
    borderRadius: 8,
    padding: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  deleteLabel: {
    color: '#b91c1c',
    fontWeight: '600',
  },
})
