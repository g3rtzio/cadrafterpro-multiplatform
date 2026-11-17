import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InsertPagesDialog } from './insert-pages-dialog';

describe('InsertPagesDialog', () => {
  let component: InsertPagesDialog;
  let fixture: ComponentFixture<InsertPagesDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InsertPagesDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(InsertPagesDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
