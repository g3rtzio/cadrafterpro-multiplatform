import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PageLabelsDialog } from './page-labels-dialog';

describe('PageLabelsDialog', () => {
  let component: PageLabelsDialog;
  let fixture: ComponentFixture<PageLabelsDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PageLabelsDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(PageLabelsDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
