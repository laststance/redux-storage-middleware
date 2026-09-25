import AsyncStorage from '@react-native-async-storage/async-storage'
import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import { createStorageMiddleware } from '@laststance/redux-storage-middleware'

export interface Note {
  id: string
  text: string
}

export interface NotesState {
  items: Note[]
  theme: 'light' | 'dark'
}

const initialState: NotesState = {
  items: [],
  theme: 'light',
}

const notesSlice = createSlice({
  name: 'notes',
  initialState,
  reducers: {
    addNote: (state, action: PayloadAction<string>) => {
      const text = action.payload.trim()
      if (text.length === 0) {
        return
      }
      state.items.push({
        id: `${Date.now()}-${state.items.length}`,
        text,
      })
    },
    deleteNote: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((note) => note.id !== action.payload)
    },
    toggleTheme: (state) => {
      state.theme = state.theme === 'light' ? 'dark' : 'light'
    },
    resetNotes: () => initialState,
  },
})

export const { addNote, deleteNote, toggleTheme, resetNotes } =
  notesSlice.actions

const rootReducer = combineReducers({
  notes: notesSlice.reducer,
})

const { middleware, reducer, api } = createStorageMiddleware({
  rootReducer,
  key: 'field-notes',
  slices: ['notes'],
  storage: AsyncStorage,
  performance: { debounceMs: 50 },
})

export const storageApi = api

export const store = configureStore({
  reducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(middleware),
})

export type RootState = ReturnType<typeof store.getState>
